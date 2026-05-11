"""Entity resolution with alias table, canonicalization, and domain tracking."""
import json
import logging
from pathlib import Path
from typing import Any

from app.config import ENTITY_ALIASES_PATH
from etl.domain_classifier import classify_entity_domains, sanitize_entity_for_neo4j

logger = logging.getLogger(__name__)


class EntityResolver:
    def __init__(self, aliases_path: Path | str | None = None):
        self.aliases_path = Path(aliases_path or ENTITY_ALIASES_PATH)
        self.aliases: dict[str, str] = {}
        self._load()

    def _load(self):
        if self.aliases_path.exists():
            with open(self.aliases_path) as f:
                self.aliases = json.load(f)
            logger.info(f"Loaded {len(self.aliases)} entity aliases")
        else:
            self.aliases = {}
            self._save()

    def _save(self):
        self.aliases_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.aliases_path, "w") as f:
            json.dump(self.aliases, f, indent=2, sort_keys=True)

    def resolve(self, name: str) -> str:
        """Resolve an entity name to its canonical form."""
        if name in self.aliases:
            return self.aliases[name]
        lower = name.lower()
        for alias, canonical in self.aliases.items():
            if alias.lower() == lower:
                return canonical
        return name

    def add_alias(self, alias: str, canonical: str):
        self.aliases[alias] = canonical
        self._save()

    def add_aliases(self, mappings: dict[str, str]):
        self.aliases.update(mappings)
        self._save()

    def get_all(self) -> dict[str, str]:
        return dict(self.aliases)

    def resolve_triples(self, triples: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Apply entity resolution to triples."""
        resolved = []
        for t in triples:
            rt = dict(t)
            rt["subject"] = self.resolve(t["subject"])
            rt["object"] = self.resolve(t["object"])
            resolved.append(rt)
        return resolved

    def extract_entities_from_triples(self, triples: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Extract unique resolved entities with domains, types, and source agents."""
        entities: dict[str, dict[str, Any]] = {}
        type_votes: dict[str, dict[str, int]] = {}

        for t in triples:
            subj = self.resolve(t["subject"])
            obj = self.resolve(t["object"])
            conf = t.get("confidence", 1.0)
            created = t.get("created_at", "")
            agent_id = t.get("agent_id") or "default"
            subj_type = t.get("subject_type")
            obj_type = t.get("object_type")

            for name in [subj, obj]:
                if name not in entities:
                    entities[name] = {
                        "name": name,
                        "type": "unknown",
                        "msam_confidence": conf,
                        "first_seen": created,
                        "last_seen": created,
                        "source_agents": {agent_id},
                        "_triples": []
                    }
                else:
                    e = entities[name]
                    e["msam_confidence"] = max(e["msam_confidence"], conf)
                    if created and (not e["first_seen"] or created < e["first_seen"]):
                        e["first_seen"] = created
                    if created and (not e["last_seen"] or created > e["last_seen"]):
                        e["last_seen"] = created
                    e["source_agents"].add(agent_id)

                entities[name]["_triples"].append(t)

            # Vote on types using subject_type / object_type from triples
            if subj_type:
                type_votes.setdefault(subj, {})
                type_votes[subj][subj_type] = type_votes[subj].get(subj_type, 0) + 1
            if obj_type:
                type_votes.setdefault(obj, {})
                type_votes[obj][obj_type] = type_votes[obj].get(obj_type, 0) + 1

        # Classify domains, resolve type by majority vote, sanitize
        result = []
        for name, e in entities.items():
            e["domains"] = classify_entity_domains(name, e["_triples"])
            e["source_agents"] = [a for a in e["source_agents"] if a is not None]
            del e["_triples"]

            # Pick type with most votes. "unknown" only if no triple annotated this entity.
            votes = type_votes.get(name)
            if votes:
                e["type"] = max(votes.items(), key=lambda kv: kv[1])[0]

            safe = sanitize_entity_for_neo4j(e)
            if safe is not None:
                result.append(safe)

        return result
