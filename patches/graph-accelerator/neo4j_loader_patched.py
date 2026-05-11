"""MERGE-based idempotent Neo4j loader with cross-domain support."""
import logging
from datetime import datetime, timezone
from typing import Any

from app.config import BATCH_SIZE
from app.neo4j_client import Neo4jClient
from etl.domain_classifier import classify_atom_domains, classify_triple_domains

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _batch(items: list, size: int = BATCH_SIZE):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _clean_list(values: list, default: str = "") -> list:
    """Remove None values from a list before storing in Neo4j properties."""
    return [v if v is not None else default for v in values]


def load_entities(entities: list[dict[str, Any]]):
    """MERGE Entity nodes with domains and source_agents."""
    synced = _now_iso()
    count = 0
    for batch in _batch(entities):
        with Neo4jClient.session() as session:
            for e in batch:
                session.run("""
                    MERGE (e:Entity {name: $name})
                    SET e.type = $type,
                        e.domains = $domains,
                        e.source_agents = $source_agents,
                        e.msam_confidence = $msam_confidence,
                        e.first_seen = $first_seen,
                        e.last_seen = $last_seen,
                        e.synced_at = $synced_at
                """, {
                    "name": e["name"],
                    "type": e.get("type", "unknown"),
                    "domains": _clean_list(e.get("domains", ["Ops"])),
                    "source_agents": _clean_list(e.get("source_agents", [])),
                    "msam_confidence": e.get("msam_confidence", 1.0),
                    "first_seen": e.get("first_seen") or "",
                    "last_seen": e.get("last_seen") or "",
                    "synced_at": synced
                })
                count += 1
    logger.info(f"Loaded {count} Entity nodes")
    return count


def load_atoms(atoms: list[dict[str, Any]]):
    """MERGE Atom nodes with domain labels and agent_id."""
    synced = _now_iso()
    count = 0
    for batch in _batch(atoms):
        with Neo4jClient.session() as session:
            for a in batch:
                domains = _clean_list(classify_atom_domains(a))
                session.run("""
                    MERGE (a:Atom {atom_id: $atom_id})
                    SET a.stream = $stream,
                        a.profile = $profile,
                        a.stability = $stability,
                        a.retrievability = $retrievability,
                        a.access_count = $access_count,
                        a.last_accessed_at = $last_accessed_at,
                        a.arousal = $arousal,
                        a.valence = $valence,
                        a.created_at = $created_at,
                        a.agent_id = $agent_id,
                        a.domains = $domains,
                        a.synced_at = $synced_at
                """, {
                    "atom_id": a["id"],
                    "stream": a.get("stream") or "",
                    "profile": a.get("profile") or "",
                    "stability": a["stability"] if a.get("stability") is not None else 1.0,
                    "retrievability": a["retrievability"] if a.get("retrievability") is not None else 1.0,
                    "access_count": a["access_count"] if a.get("access_count") is not None else 0,
                    "last_accessed_at": a.get("last_accessed_at") or "",
                    "arousal": a["arousal"] if a.get("arousal") is not None else 0.5,
                    "valence": a["valence"] if a.get("valence") is not None else 0.0,
                    "created_at": a.get("created_at") or "",
                    "agent_id": a.get("agent_id") or "default",
                    "domains": domains,
                    "synced_at": synced
                })
                count += 1
    logger.info(f"Loaded {count} Atom nodes")
    return count


def _predicate_to_rel_type(predicate: str) -> str:
    """Convert a predicate like 'uses_tool' to a Neo4j relationship type like 'USES_TOOL'."""
    clean = predicate.strip().upper()
    clean = clean.replace(" ", "_").replace("-", "_")
    clean = "".join(c for c in clean if c.isalnum() or c == "_")
    if not clean or clean[0].isdigit():
        clean = "REL_" + clean if clean else "RELATES_TO"
    return clean


def load_triples_as_relationships(triples: list[dict[str, Any]]):
    """Load triples as typed relationships + MENTIONED_IN with source_agent_id and domains.

    Uses the predicate as the actual Neo4j relationship type (e.g. USES_TOOL, IS_FOUNDER_OF)
    instead of a generic RELATES_TO with predicate stored as property.
    """
    synced = _now_iso()
    typed_count = 0
    mention_count = 0

    for batch in _batch(triples):
        with Neo4jClient.session() as session:
            for t in batch:
                agent_id = t.get("agent_id") or "default"
                domains = _clean_list(classify_triple_domains(t))
                rel_type = _predicate_to_rel_type(t["predicate"])

                cypher = f"""
                    MATCH (s:Entity {{name: $subject}})
                    MATCH (o:Entity {{name: $object}})
                    MERGE (s)-[r:{rel_type}]->(o)
                    SET r.predicate = $predicate,
                        r.confidence = $confidence,
                        r.created_at = $created_at,
                        r.valid_from = $created_at,
                        r.source_agent_id = $agent_id,
                        r.domains = $domains,
                        r.synced_at = $synced_at
                """
                session.run(cypher, {
                    "subject": t["subject"],
                    "object": t["object"],
                    "predicate": t["predicate"],
                    "confidence": t.get("confidence", 1.0),
                    "created_at": t.get("created_at", ""),
                    "agent_id": agent_id,
                    "domains": domains,
                    "synced_at": synced
                })
                typed_count += 1

                atom_id = t.get("atom_id", "")
                if atom_id:
                    for entity_name in [t["subject"], t["object"]]:
                        session.run("""
                            MATCH (e:Entity {name: $name})
                            MATCH (a:Atom {atom_id: $atom_id})
                            MERGE (e)-[r:MENTIONED_IN]->(a)
                            SET r.confidence = $confidence,
                                r.created_at = $created_at,
                                r.source_agent_id = $agent_id,
                                r.synced_at = $synced_at
                        """, {
                            "name": entity_name,
                            "atom_id": atom_id,
                            "confidence": t.get("confidence", 1.0),
                            "created_at": t.get("created_at", ""),
                            "agent_id": agent_id,
                            "synced_at": synced
                        })
                        mention_count += 1

    logger.info(f"Loaded {typed_count} typed relationships + {mention_count} MENTIONED_IN relationships")
    return typed_count + mention_count


def load_commits(commits: list[dict[str, Any]]):
    """MERGE Commit nodes with Project_Two domain."""
    synced = _now_iso()
    count = 0
    for batch in _batch(commits):
        with Neo4jClient.session() as session:
            for c in batch:
                session.run("""
                    MERGE (c:Commit {sha: $sha})
                    SET c.author = $author,
                        c.message = $message,
                        c.timestamp = $timestamp,
                        c.files_changed = $files_changed,
                        c.domains = ["Project_Two"],
                        c.synced_at = $synced_at
                """, {
                    "sha": c["sha"],
                    "author": c.get("author", ""),
                    "message": c.get("message", ""),
                    "timestamp": c.get("timestamp", ""),
                    "files_changed": c.get("files_changed", 0),
                    "synced_at": synced
                })
                count += 1
    logger.info(f"Loaded {count} Commit nodes")
    return count


def load_files_and_packages(files: list[dict], packages: list[dict]):
    """MERGE File and Package nodes with Project_Two domain."""
    synced = _now_iso()
    pkg_count = 0
    file_count = 0

    with Neo4jClient.session() as session:
        for p in packages:
            session.run("""
                MERGE (p:Package {name: $name})
                SET p.purpose = $purpose, p.domains = ["Project_Two"], p.synced_at = $synced_at
            """, {"name": p["name"], "purpose": p.get("purpose", ""), "synced_at": synced})
            pkg_count += 1

    for batch in _batch(files):
        with Neo4jClient.session() as session:
            for f in batch:
                session.run("""
                    MERGE (f:File {path: $path})
                    SET f.package = $package, f.language = $language,
                        f.domains = ["Project_Two"], f.synced_at = $synced_at
                """, {
                    "path": f["path"],
                    "package": f.get("package", "root"),
                    "language": f.get("language", "other"),
                    "synced_at": synced
                })
                session.run("""
                    MATCH (f:File {path: $path})
                    MATCH (p:Package {name: $package})
                    MERGE (f)-[r:IN_PACKAGE]->(p)
                    SET r.synced_at = $synced_at
                """, {
                    "path": f["path"],
                    "package": f.get("package", "root"),
                    "synced_at": synced
                })
                file_count += 1

    logger.info(f"Loaded {pkg_count} Package + {file_count} File nodes")
    return pkg_count + file_count


def load_commit_file_relationships(commits: list[dict[str, Any]]):
    """Create MODIFIED relationships between Commits and Files."""
    synced = _now_iso()
    count = 0
    for batch in _batch(commits):
        with Neo4jClient.session() as session:
            for c in batch:
                for filepath in c.get("files", []):
                    session.run("""
                        MATCH (c:Commit {sha: $sha})
                        MATCH (f:File {path: $path})
                        MERGE (c)-[r:MODIFIED]->(f)
                        SET r.synced_at = $synced_at, r.source_agent_id = "gateway-one"
                    """, {"sha": c["sha"], "path": filepath, "synced_at": synced})
                    count += 1
    logger.info(f"Loaded {count} MODIFIED relationships")
    return count


def load_trades(trades: list[dict[str, Any]]):
    """MERGE TradeOutcome nodes with Project_Two domain."""
    synced = _now_iso()
    count = 0
    for batch in _batch(trades):
        with Neo4jClient.session() as session:
            for t in batch:
                hold_min = None
                if t.get("opened_at") and t.get("closed_at"):
                    try:
                        delta = t["closed_at"] - t["opened_at"]
                        hold_min = delta.total_seconds() / 60.0
                    except Exception:
                        pass

                ts = t.get("opened_at", "")
                if hasattr(ts, "isoformat"):
                    ts = ts.isoformat()

                session.run("""
                    MERGE (t:TradeOutcome {trade_id: $trade_id})
                    SET t.token = $token,
                        t.pnl = $pnl,
                        t.hold_time_min = $hold_time_min,
                        t.entry_price = $entry_price,
                        t.exit_price = $exit_price,
                        t.config_version = $config_version,
                        t.timestamp = $timestamp,
                        t.domains = ["Project_Two"],
                        t.synced_at = $synced_at
                """, {
                    "trade_id": str(t["id"]),
                    "token": t.get("token_mint", ""),
                    "pnl": float(t.get("pnl_sol") or 0),
                    "hold_time_min": hold_min,
                    "entry_price": float(t.get("entry_price") or 0),
                    "exit_price": float(t.get("exit_price") or 0),
                    "config_version": str(t.get("config_id", "")),
                    "timestamp": str(ts),
                    "synced_at": synced
                })
                count += 1
    logger.info(f"Loaded {count} TradeOutcome nodes")
    return count


def upgrade_typed_relationships():
    """Convert any remaining RELATES_TO relationships to typed relationships."""
    converted = 0
    with Neo4jClient.session() as session:
        result = session.run("""
            MATCH (s)-[r:RELATES_TO]->(o)
            RETURN elementId(s) as sid, elementId(o) as oid, properties(r) as props
        """)
        records = list(result)

    if not records:
        logger.info("No RELATES_TO relationships to upgrade")
        return 0

    with Neo4jClient.session() as session:
        for rec in records:
            props = dict(rec["props"])
            # Filter nulls from any list properties before setting on new relationship
            for k, v in props.items():
                if isinstance(v, list):
                    props[k] = _clean_list(v)
            predicate = props.pop("predicate", "RELATES_TO")
            rel_type = _predicate_to_rel_type(predicate)

            cypher = f"""
                MATCH (s) WHERE elementId(s) = $sid
                MATCH (o) WHERE elementId(o) = $oid
                CREATE (s)-[r:{rel_type}]->(o)
                SET r = $props, r.predicate = $predicate
                WITH s, o
                MATCH (s)-[old:RELATES_TO]->(o)
                DELETE old
            """
            session.run(cypher, {
                "sid": rec["sid"],
                "oid": rec["oid"],
                "props": props,
                "predicate": predicate,
            })
            converted += 1

    logger.info(f"Upgraded {converted} RELATES_TO relationships to typed relationships")
    return converted


def apply_domain_labels_to_all():
    """Apply Neo4j labels to Entity nodes based on their domains property."""
    labeled = 0
    with Neo4jClient.session() as session:
        result = session.run("""
            MATCH (e:Entity)
            WHERE e.domains IS NOT NULL AND size(e.domains) > 0
            RETURN e.name as name, e.domains as domains
        """)
        records = list(result)

    if not records:
        logger.info("No entities with domains to label")
        return 0

    valid_labels = {"Ops", "Project_One", "Project_Two", "Legal", "Social"}
    with Neo4jClient.session() as session:
        for rec in records:
            for domain in rec["domains"]:
                if domain in valid_labels:
                    cypher = f"""
                        MATCH (e:Entity {{name: $name}})
                        SET e:{domain}
                    """
                    session.run(cypher, {"name": rec["name"]})
            labeled += 1

    logger.info(f"Applied domain labels to {labeled} entities")
    return labeled


import re as _re

# Labels reserved by the graph accelerator for its own structural concerns.
# Everything else is dynamic and can appear/disappear as the ontology evolves.
_RESERVED_LABELS = {"Entity", "Atom", "Commit", "Package", "File", "TradeOutcome",
                    "Ops", "Project_One", "Project_Two", "Legal", "Social"}

_LABEL_SAFE_RE = _re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")


def _sanitize_label(type_name: str) -> str | None:
    """Return the type name if it's a safe Cypher label identifier, else None."""
    if not type_name or type_name == "unknown":
        return None
    if not _LABEL_SAFE_RE.match(type_name):
        return None
    if type_name in _RESERVED_LABELS:
        return None
    return type_name


def apply_type_labels_to_all():
    """Apply dynamic entity-type labels to Entity nodes based on the `type` property.

    The ontology is open — any Title_Case type coming from MSAM is propagated
    as a Neo4j label. Reserved structural labels (Entity, Atom, etc.) and
    domain labels (Ops, Legal, ...) are left untouched. Stale type labels are
    removed when an entity's type changes between runs.
    """
    labeled = 0
    with Neo4jClient.session() as session:
        # Discover the full universe of labels currently in use so we know
        # which ones to scrub before re-applying a fresh one per entity.
        universe_result = session.run("CALL db.labels() YIELD label RETURN label")
        all_labels = {r["label"] for r in universe_result}
        dynamic_labels = {l for l in all_labels if _sanitize_label(l)}

        records = list(session.run("""
            MATCH (e:Entity)
            WHERE e.type IS NOT NULL AND e.type <> 'unknown'
            RETURN e.name as name, e.type as type
        """))

    if not records:
        logger.info("No entities with types to label")
        return 0

    with Neo4jClient.session() as session:
        for rec in records:
            type_name = rec["type"]
            safe = _sanitize_label(type_name)
            if not safe:
                continue

            # 1. Remove any previous dynamic type labels from this node (idempotent
            #    under type migration). We only touch labels in `dynamic_labels`,
            #    never the reserved structural/domain set.
            if dynamic_labels:
                remove_parts = ", ".join(f"e:{l}" for l in dynamic_labels)
                session.run(
                    f"MATCH (e:Entity {{name: $name}}) REMOVE {remove_parts}",
                    {"name": rec["name"]},
                )

            # 2. Apply the current type label.
            session.run(
                f"MATCH (e:Entity {{name: $name}}) SET e:{safe}",
                {"name": rec["name"]},
            )
            labeled += 1

    logger.info(f"Applied type labels to {labeled} entities")
    return labeled


def cleanup_tombstoned(atom_states: list[dict], triple_states: list[dict]):
    """Remove Neo4j nodes whose MSAM source is tombstoned/dormant."""
    deleted = 0
    tombstoned_atoms = [a["id"] for a in atom_states if a["state"] in ("tombstone", "dormant")]
    if tombstoned_atoms:
        for batch in _batch(tombstoned_atoms):
            with Neo4jClient.session() as session:
                result = session.run("""
                    UNWIND $ids AS aid
                    MATCH (a:Atom {atom_id: aid})
                    DETACH DELETE a
                    RETURN count(a) as deleted
                """, {"ids": batch})
                record = result.single()
                if record:
                    deleted += record["deleted"]
    
    logger.info(f"Cleaned up {deleted} tombstoned/dormant nodes")
    return deleted
