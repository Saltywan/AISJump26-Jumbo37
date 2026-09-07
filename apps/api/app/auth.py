"""Real accounts — email + password, a DB-backed session cookie.

Not OAuth, not email verification, not password reset. Each of those is real
work — social login alone is redirect URIs and consent screens, easily a
week — and buys this POC nothing over what's here. What this file promises is
narrower and is the reason it exists at all: a user's personal library is
really theirs across devices, and the admin page — which can edit the library
every user sees — is not an honour-system URL a role picker used to be.

Password hashing is stdlib PBKDF2-HMAC-SHA256, not bcrypt/passlib. This API's
Dockerfile is deliberately small (see its own comment: "The API is small"),
and PBKDF2 at a real iteration count needs nothing beyond hashlib + hmac +
secrets, all already in the standard library — no image rebuild to add a
dependency for the one thing that has to be right on day one.

The session token IS the cookie value — an opaque random string, looked up
against the `session` table on every request. Deliberately not a signed,
stateless JWT: logging out, or revoking a session for any other reason, is
one DELETE. A JWT would need a blocklist to do the same thing, which is a
database table wearing a costume.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import os
import secrets
from typing import Optional

from fastapi import Cookie, Depends, HTTPException, Response
from sqlalchemy.orm import Session as DbSession

from .db import get_session
from .models import Session as SessionRow, User

COOKIE_NAME = "jumpais_session"
SESSION_TTL = dt.timedelta(days=30)

# ~250ms per hash on typical hardware in 2026 — deliberately slow. Fast
# hashing is the whole vulnerability in a password scheme; this number is
# the one thing in this file worth re-checking against current guidance
# before it ships anywhere real.
PBKDF2_ITERATIONS = 260_000


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITERATIONS
    )
    return f"{salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """`compare_digest`, not `==` — a stored hash is not a secret an attacker
    needs to steal to exploit a timing side-channel against, but the habit of
    reaching for it here is the one that matters when this function is
    copied somewhere it does."""
    try:
        salt, digest_hex = stored.split("$", 1)
    except ValueError:
        return False
    check = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITERATIONS
    )
    return hmac.compare_digest(check.hex(), digest_hex)


# A fixed hash to check a login attempt against when the email doesn't exist,
# so that path spends the same ~250ms in PBKDF2 the real path does. Without
# this, "no such user" returns in a couple of milliseconds and "wrong
# password" takes a quarter of a second — a 100x gap that is a working email
# enumeration oracle with no statistics required, over a login endpoint with
# no other rate limit yet (see docs/BACKLOG.md). Generated once per process,
# not persisted anywhere — it never needs to verify anything real.
DUMMY_PASSWORD_HASH = hash_password(secrets.token_urlsafe(32))


def _cookie_secure() -> bool:
    return os.environ.get("COOKIE_SECURE", "false").lower() == "true"


def _cookie_samesite() -> str:
    """"lax" works today because web and api are both on localhost, which is
    same-site. The moment they're on different registrable domains — which
    WEB_ORIGIN's comma-list (main.py) exists to support — Lax silently stops
    sending the cookie on cross-site requests: login returns 200 with a user
    body and every request after it 401s, the worst kind of thing to debug
    blind. Set COOKIE_SAMESITE=none (and COOKIE_SECURE=true — a browser
    refuses None without Secure) once that's the real deployment shape."""
    return os.environ.get("COOKIE_SAMESITE", "lax").lower()


def start_session(db: DbSession, user: User, response: Response) -> None:
    token = secrets.token_urlsafe(32)
    expires = dt.datetime.now(dt.timezone.utc) + SESSION_TTL
    db.add(SessionRow(id=token, user_id=user.id, expires_at=expires))
    db.commit()
    response.set_cookie(
        COOKIE_NAME,
        token,
        httponly=True,
        samesite=_cookie_samesite(),
        secure=_cookie_secure(),
        max_age=int(SESSION_TTL.total_seconds()),
        path="/",
    )


def end_session(db: DbSession, token: Optional[str], response: Response) -> None:
    if token:
        row = db.get(SessionRow, token)
        if row is not None:
            db.delete(row)
            db.commit()
    response.delete_cookie(COOKIE_NAME, path="/")


def _resolve(token: Optional[str], db: DbSession) -> Optional[User]:
    if not token:
        return None
    row = db.get(SessionRow, token)
    if row is None or row.expires_at < dt.datetime.now(dt.timezone.utc):
        return None
    return db.get(User, row.user_id)


def current_user(
    jumpais_session: Optional[str] = Cookie(default=None),
    db: DbSession = Depends(get_session),
) -> User:
    user = _resolve(jumpais_session, db)
    if user is None:
        raise HTTPException(401, "not signed in")
    return user


def optional_user(
    jumpais_session: Optional[str] = Cookie(default=None),
    db: DbSession = Depends(get_session),
) -> Optional[User]:
    return _resolve(jumpais_session, db)


def require_admin(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(403, "admin only")
    return user
