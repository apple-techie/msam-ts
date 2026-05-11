"""Read-only MSAM PostgreSQL reader. Never writes to MSAM."""
import os
import psycopg2
import psycopg2.extras
from typing import Any


DATABASE_URL = os.getenv(
    "MSAM_PG_URL",
    "postgresql://msam:msam@msam-db:5432/msam"
)


def _get_connection():
    conn = psycopg2.connect(DATABASE_URL)
    conn.set_session(readonly=True)
    return conn


def read_atoms() -> list[dict[str, Any]]:
    conn = _get_connection()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT id, stream, profile, state, stability, retrievability,
                       access_count, last_accessed_at, arousal, valence, created_at,
                       source_type, topics, agent_id
                FROM atoms
                WHERE state IN ('active', 'fading')
                  AND (source_type IS NULL OR source_type != 'graph_insight')
            """)
            rows = cur.fetchall()
            return [dict(r) for r in rows]
    finally:
        conn.close()


def read_triples() -> list[dict[str, Any]]:
    conn = _get_connection()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT t.id, t.atom_id, t.subject, t.subject_type,
                       t.predicate, t.object, t.object_type,
                       t.confidence, t.created_at, a.agent_id
                FROM triples t
                LEFT JOIN atoms a ON t.atom_id = a.id
                WHERE t.state = 'active'
            """)
            rows = cur.fetchall()
            return [dict(r) for r in rows]
    finally:
        conn.close()


def read_all_atom_ids_and_states() -> list[dict[str, str]]:
    conn = _get_connection()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id, state FROM atoms")
            rows = cur.fetchall()
            return [dict(r) for r in rows]
    finally:
        conn.close()


def read_all_triple_ids_and_states() -> list[dict[str, str]]:
    conn = _get_connection()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id, state FROM triples")
            rows = cur.fetchall()
            return [dict(r) for r in rows]
    finally:
        conn.close()
