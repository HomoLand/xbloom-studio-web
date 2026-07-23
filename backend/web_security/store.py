"""Durable web auth store (SQLite WAL). Web-owned; never touches BLE.

Stores only hashes of pairing tokens, session secrets, and CSRF secrets.
Pairing consumption is atomic. Invalid pairing attempts are rate-limited
durably so process restart does not erase protection.
"""

from __future__ import annotations

import hashlib
import secrets
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator
from contextlib import contextmanager

from xbloom_paths import state_dir as resolve_state_dir

Clock = Callable[[], float]

AUTH_DB_NAME = "web_auth.sqlite3"
TOKEN_BYTES = 32


def _hash_secret(secret: str) -> str:
    """SHA-256 hex digest of a secret (no pepper; secret entropy is high)."""

    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def new_secret() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


@dataclass(frozen=True)
class PairingRecord:
    pairing_id: str
    token: str  # plaintext only returned at creation / exchange input
    expires_at: float
    pairing_url: str | None


@dataclass(frozen=True)
class SessionRecord:
    session_id: str
    created_at: float
    expires_at: float
    last_seen_at: float
    client_label: str | None
    client_ip: str | None
    revoked_at: float | None = None


@dataclass(frozen=True)
class SessionSecrets:
    session_id: str
    session_token: str
    csrf_token: str
    expires_at: float
    client_label: str | None


@dataclass(frozen=True)
class AuthenticatedSession:
    session_id: str
    expires_at: float
    client_label: str | None
    client_ip: str | None
    csrf_hash: str


class AuthStore:
    """Transactional SQLite store under the resolved xBloom state directory.

    When constructed without a fixed ``db_path``, the database location is
    re-resolved from ``state_root`` / ``XBLOOM_STATE_DIR`` on each connection so
    process-level default ``main.app`` does not pin a path at import time
    (existing tests set ``XBLOOM_STATE_DIR`` per case before requests).
    """

    def __init__(
        self,
        *,
        db_path: Path | None = None,
        state_root: Path | None = None,
        clock: Clock | None = None,
    ) -> None:
        self._clock: Clock = clock or time.time
        self._fixed_db_path = Path(db_path) if db_path is not None else None
        self._state_root = Path(state_root) if state_root is not None else None
        self._lock = threading.RLock()
        self._initialized_paths: set[str] = set()
        # Eager schema for fixed paths (tests); env-resolved paths init on first use.
        if self._fixed_db_path is not None:
            self._ensure_schema(self._fixed_db_path)

    @property
    def db_path(self) -> Path:
        if self._fixed_db_path is not None:
            return self._fixed_db_path
        root = self._state_root if self._state_root is not None else resolve_state_dir()
        return Path(root) / "web" / AUTH_DB_NAME

    def now(self) -> float:
        return float(self._clock())

    def _resolve_db_path(self) -> Path:
        path = self.db_path
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def _connect(self) -> sqlite3.Connection:
        path = self._resolve_db_path()
        self._ensure_schema(path)
        conn = sqlite3.connect(
            str(path),
            timeout=30.0,
            isolation_level=None,  # autocommit off; we issue BEGIN/COMMIT
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _prepare_connection(self, conn: sqlite3.Connection) -> None:
        # WAL/synchronous outside explicit transactions (PRAGMA may commit).
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            conn = self._connect()
            try:
                self._prepare_connection(conn)
                conn.execute("BEGIN IMMEDIATE")
                yield conn
                conn.execute("COMMIT")
            except Exception:
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise
            finally:
                conn.close()

    def _ensure_schema(self, path: Path) -> None:
        key = str(path)
        if key in self._initialized_paths:
            return
        # executescript() issues implicit commits; do not wrap in BEGIN/COMMIT.
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(path), timeout=30.0, isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS pairing_tokens (
                    pairing_id TEXT PRIMARY KEY,
                    token_hash TEXT NOT NULL UNIQUE,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    consumed_at REAL,
                    created_by_session_id TEXT,
                    client_label TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_pairing_expires
                    ON pairing_tokens(expires_at);

                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    token_hash TEXT NOT NULL UNIQUE,
                    csrf_hash TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    last_seen_at REAL NOT NULL,
                    revoked_at REAL,
                    client_label TEXT,
                    client_ip TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_sessions_expires
                    ON sessions(expires_at);

                CREATE TABLE IF NOT EXISTS pairing_rate_limits (
                    client_ip TEXT PRIMARY KEY,
                    window_start REAL NOT NULL,
                    fail_count INTEGER NOT NULL
                );
                """
            )
        finally:
            conn.close()
        self._initialized_paths.add(key)

    # ------------------------------------------------------------------
    # Pairing
    # ------------------------------------------------------------------

    def create_pairing(
        self,
        *,
        ttl_s: int,
        public_origin: str | None,
        created_by_session_id: str | None = None,
        client_label: str | None = None,
    ) -> PairingRecord:
        now = self.now()
        pairing_id = new_id("pair")
        token = new_secret()
        token_hash = _hash_secret(token)
        expires_at = now + float(ttl_s)
        pairing_url = None
        if public_origin:
            # Fragments are not sent in HTTP requests or Referer headers. The
            # frontend reads the token locally and posts it to /api/auth/pair.
            pairing_url = f"{public_origin}/pair#token={token}"

        with self._tx() as conn:
            conn.execute(
                """
                INSERT INTO pairing_tokens (
                    pairing_id, token_hash, created_at, expires_at,
                    consumed_at, created_by_session_id, client_label
                ) VALUES (?, ?, ?, ?, NULL, ?, ?)
                """,
                (
                    pairing_id,
                    token_hash,
                    now,
                    expires_at,
                    created_by_session_id,
                    client_label,
                ),
            )
        return PairingRecord(
            pairing_id=pairing_id,
            token=token,
            expires_at=expires_at,
            pairing_url=pairing_url,
        )

    def check_pairing_rate_limit(
        self,
        client_ip: str,
        *,
        max_failures: int,
        window_s: int,
    ) -> bool:
        """Return True if the client is currently rate-limited."""

        now = self.now()
        with self._tx() as conn:
            row = conn.execute(
                "SELECT window_start, fail_count FROM pairing_rate_limits WHERE client_ip = ?",
                (client_ip,),
            ).fetchone()
            if row is None:
                return False
            window_start = float(row["window_start"])
            fail_count = int(row["fail_count"])
            if now - window_start >= float(window_s):
                return False
            return fail_count >= max_failures

    def record_pairing_failure(
        self,
        client_ip: str,
        *,
        max_failures: int,
        window_s: int,
    ) -> int:
        """Increment durable failure counter. Return the new fail_count."""

        now = self.now()
        with self._tx() as conn:
            row = conn.execute(
                "SELECT window_start, fail_count FROM pairing_rate_limits WHERE client_ip = ?",
                (client_ip,),
            ).fetchone()
            if row is None or now - float(row["window_start"]) >= float(window_s):
                conn.execute(
                    """
                    INSERT INTO pairing_rate_limits (client_ip, window_start, fail_count)
                    VALUES (?, ?, 1)
                    ON CONFLICT(client_ip) DO UPDATE SET
                        window_start = excluded.window_start,
                        fail_count = excluded.fail_count
                    """,
                    (client_ip, now),
                )
                return 1
            new_count = int(row["fail_count"]) + 1
            conn.execute(
                """
                UPDATE pairing_rate_limits
                SET fail_count = ?
                WHERE client_ip = ?
                """,
                (new_count, client_ip),
            )
            return new_count

    def clear_pairing_failures(self, client_ip: str) -> None:
        with self._tx() as conn:
            conn.execute(
                "DELETE FROM pairing_rate_limits WHERE client_ip = ?",
                (client_ip,),
            )

    def consume_pairing_and_create_session(
        self,
        token: str,
        *,
        session_ttl_s: int,
        client_ip: str | None,
        client_label: str | None = None,
    ) -> SessionSecrets | None:
        """Atomically consume a one-time pairing token and create a session.

        Returns None when the token is unknown, expired, or already consumed.
        """

        now = self.now()
        token_hash = _hash_secret(token)
        session_id = new_id("sess")
        session_token = new_secret()
        csrf_token = new_secret()
        session_hash = _hash_secret(session_token)
        csrf_hash = _hash_secret(csrf_token)
        expires_at = now + float(session_ttl_s)

        with self._tx() as conn:
            row = conn.execute(
                """
                SELECT pairing_id, expires_at, consumed_at
                FROM pairing_tokens
                WHERE token_hash = ?
                """,
                (token_hash,),
            ).fetchone()
            if row is None:
                return None
            if row["consumed_at"] is not None:
                return None
            if float(row["expires_at"]) <= now:
                return None

            cur = conn.execute(
                """
                UPDATE pairing_tokens
                SET consumed_at = ?
                WHERE pairing_id = ?
                  AND consumed_at IS NULL
                  AND expires_at > ?
                """,
                (now, row["pairing_id"], now),
            )
            if cur.rowcount != 1:
                return None

            conn.execute(
                """
                INSERT INTO sessions (
                    session_id, token_hash, csrf_hash,
                    created_at, expires_at, last_seen_at,
                    revoked_at, client_label, client_ip
                ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
                """,
                (
                    session_id,
                    session_hash,
                    csrf_hash,
                    now,
                    expires_at,
                    now,
                    client_label,
                    client_ip,
                ),
            )

        return SessionSecrets(
            session_id=session_id,
            session_token=session_token,
            csrf_token=csrf_token,
            expires_at=expires_at,
            client_label=client_label,
        )

    # ------------------------------------------------------------------
    # Sessions
    # ------------------------------------------------------------------

    def authenticate_session(self, session_token: str) -> AuthenticatedSession | None:
        now = self.now()
        token_hash = _hash_secret(session_token)
        with self._tx() as conn:
            row = conn.execute(
                """
                SELECT session_id, csrf_hash, expires_at, client_label, client_ip,
                       revoked_at
                FROM sessions
                WHERE token_hash = ?
                """,
                (token_hash,),
            ).fetchone()
            if row is None:
                return None
            if row["revoked_at"] is not None:
                return None
            if float(row["expires_at"]) <= now:
                return None
            conn.execute(
                "UPDATE sessions SET last_seen_at = ? WHERE session_id = ?",
                (now, row["session_id"]),
            )
            return AuthenticatedSession(
                session_id=str(row["session_id"]),
                expires_at=float(row["expires_at"]),
                client_label=row["client_label"],
                client_ip=row["client_ip"],
                csrf_hash=str(row["csrf_hash"]),
            )

    def verify_csrf(self, session: AuthenticatedSession, csrf_token: str | None) -> bool:
        if not csrf_token:
            return False
        return secrets.compare_digest(_hash_secret(csrf_token), session.csrf_hash)

    def get_session(self, session_id: str) -> SessionRecord | None:
        now = self.now()
        with self._tx() as conn:
            row = conn.execute(
                """
                SELECT session_id, created_at, expires_at, last_seen_at,
                       client_label, client_ip, revoked_at
                FROM sessions
                WHERE session_id = ?
                """,
                (session_id,),
            ).fetchone()
            if row is None:
                return None
            # Hide fully expired rows from API consumers as not found-ish
            # but still return for owner introspection when not revoked.
            if float(row["expires_at"]) <= now and row["revoked_at"] is None:
                return None
            return SessionRecord(
                session_id=str(row["session_id"]),
                created_at=float(row["created_at"]),
                expires_at=float(row["expires_at"]),
                last_seen_at=float(row["last_seen_at"]),
                client_label=row["client_label"],
                client_ip=row["client_ip"],
                revoked_at=(
                    float(row["revoked_at"]) if row["revoked_at"] is not None else None
                ),
            )

    def list_sessions(self, *, include_revoked: bool = False) -> list[SessionRecord]:
        now = self.now()
        with self._tx() as conn:
            if include_revoked:
                rows = conn.execute(
                    """
                    SELECT session_id, created_at, expires_at, last_seen_at,
                           client_label, client_ip, revoked_at
                    FROM sessions
                    ORDER BY created_at DESC
                    """
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT session_id, created_at, expires_at, last_seen_at,
                           client_label, client_ip, revoked_at
                    FROM sessions
                    WHERE revoked_at IS NULL AND expires_at > ?
                    ORDER BY created_at DESC
                    """,
                    (now,),
                ).fetchall()
        return [
            SessionRecord(
                session_id=str(r["session_id"]),
                created_at=float(r["created_at"]),
                expires_at=float(r["expires_at"]),
                last_seen_at=float(r["last_seen_at"]),
                client_label=r["client_label"],
                client_ip=r["client_ip"],
                revoked_at=(
                    float(r["revoked_at"]) if r["revoked_at"] is not None else None
                ),
            )
            for r in rows
        ]

    def revoke_session(self, session_id: str) -> bool:
        """Revoke a session by id. Returns True if a live session was revoked."""

        now = self.now()
        with self._tx() as conn:
            cur = conn.execute(
                """
                UPDATE sessions
                SET revoked_at = ?
                WHERE session_id = ?
                  AND revoked_at IS NULL
                """,
                (now, session_id),
            )
            return cur.rowcount == 1

    def revoke_session_token(self, session_token: str) -> bool:
        now = self.now()
        token_hash = _hash_secret(session_token)
        with self._tx() as conn:
            cur = conn.execute(
                """
                UPDATE sessions
                SET revoked_at = ?
                WHERE token_hash = ?
                  AND revoked_at IS NULL
                """,
                (now, token_hash),
            )
            return cur.rowcount == 1
