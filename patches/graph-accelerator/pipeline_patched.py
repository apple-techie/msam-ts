"""Main ETL orchestrator for MSAM Graph Accelerator."""
import logging
import time
from typing import Any

from etl.msam_reader import read_atoms, read_triples, read_all_atom_ids_and_states, read_all_triple_ids_and_states
from etl.hydra_reader import read_trades, read_metrics
from etl.git_reader import read_commits, extract_files_and_packages
from etl.entity_resolver import EntityResolver
from app.config import ENABLE_HYDRA, ENABLE_GIT
from etl.neo4j_loader import (
    load_entities, load_atoms, load_triples_as_relationships,
    load_commits, load_files_and_packages, load_commit_file_relationships,
    load_trades, cleanup_tombstoned, upgrade_typed_relationships,
    apply_domain_labels_to_all, apply_type_labels_to_all
)

logger = logging.getLogger(__name__)


def run_sync() -> dict[str, Any]:
    """Run full ETL pipeline: MSAM + HYDRA + Git -> Neo4j."""
    start = time.time()
    stats = {
        "entities": 0,
        "atoms": 0,
        "triples_rels": 0,
        "commits": 0,
        "files_packages": 0,
        "commit_file_rels": 0,
        "trades": 0,
        "tombstoned_cleaned": 0,
        "errors": [],
    }

    resolver = EntityResolver()

    # === MSAM Atoms ===
    try:
        atoms = read_atoms()
        stats["atoms"] = load_atoms(atoms)
        logger.info(f"Loaded {stats['atoms']} atoms")
    except Exception as e:
        logger.error(f"Atom load failed: {e}")
        stats["errors"].append(f"atoms: {e}")

    # === MSAM Triples -> Entities + Relationships ===
    try:
        triples = read_triples()
        resolved_triples = resolver.resolve_triples(triples)

        entities = resolver.extract_entities_from_triples(resolved_triples)
        stats["entities"] = load_entities(entities)

        stats["triples_rels"] = load_triples_as_relationships(resolved_triples)
        logger.info(f"Loaded {stats['entities']} entities, {stats['triples_rels']} relationships")
    except Exception as e:
        logger.error(f"Triple/entity load failed: {e}")
        stats["errors"].append(f"triples: {e}")

    # === Git Commits ===
    if ENABLE_GIT:
        try:
            commits = read_commits(max_count=500)
            if commits:
                files, packages = extract_files_and_packages(commits)
                stats["commits"] = load_commits(commits)
                stats["files_packages"] = load_files_and_packages(files, packages)
                stats["commit_file_rels"] = load_commit_file_relationships(commits)
                logger.info(f"Loaded {stats['commits']} commits, {stats['files_packages']} files/packages")
        except Exception as e:
            logger.error(f"Git load failed: {e}")
            stats["errors"].append(f"git: {e}")

    # === HYDRA Trades ===
    if ENABLE_HYDRA:
        try:
            trades = read_trades()
            if trades:
                stats["trades"] = load_trades(trades)
                logger.info(f"Loaded {stats['trades']} trades")
        except Exception as e:
            logger.error(f"Trade load failed: {e}")
            stats["errors"].append(f"trades: {e}")

    # === Tombstone Cleanup ===
    try:
        atom_states = read_all_atom_ids_and_states()
        triple_states = read_all_triple_ids_and_states()
        stats["tombstoned_cleaned"] = cleanup_tombstoned(atom_states, triple_states)
    except Exception as e:
        logger.error(f"Tombstone cleanup failed: {e}")
        stats["errors"].append(f"cleanup: {e}")

    # === Upgrade any legacy RELATES_TO relationships ===
    try:
        upgraded = upgrade_typed_relationships()
        if upgraded:
            logger.info(f"Upgraded {upgraded} legacy RELATES_TO relationships")
    except Exception as e:
        logger.error(f"Relationship upgrade failed: {e}")
        stats["errors"].append(f"rel_upgrade: {e}")

    # === Apply domain labels ===
    try:
        labeled = apply_domain_labels_to_all()
        if labeled:
            logger.info(f"Applied domain labels to {labeled} entities")
    except Exception as e:
        logger.error(f"Domain label application failed: {e}")
        stats["errors"].append(f"domain_labels: {e}")

    # === Apply entity type labels (Person, Technology, Organization, ...) ===
    try:
        typed = apply_type_labels_to_all()
        if typed:
            logger.info(f"Applied entity-type labels to {typed} entities")
    except Exception as e:
        logger.error(f"Type label application failed: {e}")
        stats["errors"].append(f"type_labels: {e}")

    elapsed = time.time() - start
    stats["elapsed_seconds"] = round(elapsed, 2)
    stats["success"] = len(stats["errors"]) == 0

    logger.info(f"ETL complete in {elapsed:.1f}s - {stats}")
    return stats
