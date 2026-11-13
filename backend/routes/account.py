"""Host-owned xBloom session. Passwords are used once and never persisted."""

from __future__ import annotations

import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.request import urlopen
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from public_contract import SafeValidationRoute, sanitize_public_output
from xbloom_catalog import (
    BASE_URLS, ENDPOINTS, CatalogError, _candidate_records,
    _cloud_request, _ephemeral_account_session,
)
from xbloom_paths import skill_state_dir


router = APIRouter(prefix="/api/account", tags=["account"], route_class=SafeValidationRoute)
_lock = threading.RLock()
_share_endpoints = {
    "tuRecipeShare.tuhtml", "tuShareRecipe.tuhtml", "tuRecipeShareLink.tuhtml",
    "tuRecipeShareAdd.tuhtml", "tuMyRecipeShare.tuhtml", "tuShareAdd.tuhtml",
    "tuCreateShare.tuhtml",
}
_allowed_endpoints = set(ENDPOINTS.values()) | _share_endpoints | {
    "tuBrewRecordList.tuhtml", "tuRecipeAdd.tuhtml", "tuRecipeDelete.tuhtml",
}


def _path() -> Path:
    return skill_state_dir() / "account" / "session.json"


def _load() -> dict[str, Any] | None:
    try:
        return json.loads(_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        raise HTTPException(503, "Stored xBloom session could not be read; sign in again") from None


def _save(record: dict[str, Any]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".session-")
    try:
        os.chmod(name, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(record, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def _public(record: dict[str, Any] | None) -> dict[str, Any]:
    if not record:
        return {"configured": False}
    return {
        "configured": True,
        "email": record["email"],
        "region": record["region"],
        "languageType": record["session"]["languageType"],
        "saved_at": record["saved_at"],
        "session": {"hostSession": record["id"], "memberId": record["session"]["memberId"]},
    }


class LoginBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(min_length=3, max_length=320)
    password: SecretStr = Field(min_length=1, max_length=1024)
    region: Literal["china", "international"] = "china"
    languageType: int = Field(default=1, ge=0, le=3)


@router.get("/status")
def status(response: Response) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    with _lock:
        return _public(_load())


@router.post("/login")
def login(body: LoginBody, response: Response) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    try:
        region, session = _ephemeral_account_session(
            email=body.email, password=body.password.get_secret_value(),
            region=body.region, language_type=body.languageType,
            timeout=20, opener=urlopen, client_secret=None,
        )
    except CatalogError:
        # Never echo vendor bodies or request credentials, including in validation errors.
        raise HTTPException(400, "xBloom login failed; check email, password and region, then retry") from None
    record = {
        "id": uuid4().hex, "email": body.email.strip(), "region": region,
        "saved_at": datetime.now(timezone.utc).isoformat(), "session": session,
    }
    with _lock:
        _save(record)
    return _public(record)


@router.post("/logout")
def logout() -> dict[str, bool]:
    with _lock:
        _path().unlink(missing_ok=True)
    return {"configured": False}


class RequestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    endpoint: str = Field(min_length=1, max_length=80)
    form: dict[str, Any]


@router.post("/request")
def account_request(body: RequestBody, response: Response) -> Any:
    response.headers["Cache-Control"] = "no-store"
    if body.endpoint not in _allowed_endpoints:
        raise HTTPException(422, "Unsupported xBloom account operation")
    if len(json.dumps(body.form)) > 128 * 1024:
        raise HTTPException(413, "xBloom account form is too large")
    with _lock:
        record = _load()
    if not record:
        raise HTTPException(409, "xBloom account login required; sign in in Settings")
    if body.form.get("hostSession") != record["id"]:
        raise HTTPException(409, "xBloom account changed; retry with the current account")
    # The caller chooses the operation, never the host, bearer token or account identity.
    form = {**body.form, **record["session"]}
    for key in ("hostSession", "password", "email"):
        form.pop(key, None)
    if body.endpoint in {"tuRecipeAdd.tuhtml", "tuRecipeDelete.tuhtml"} | _share_endpoints:
        form["interfaceVersion"] = 20240918
    if "creatorId" in form:
        form["creatorId"] = record["session"]["memberId"]
    def send(endpoint: str, data: dict[str, Any]) -> Any:
        return _cloud_request(base_url=BASE_URLS[record["region"]], endpoint=endpoint,
                              form=data, timeout=20)

    try:
        if body.endpoint == "tuRecipeDelete.tuhtml" or body.endpoint in _share_endpoints:
            table_id = body.form.get("tableId", body.form.get("recipeId"))
            owned = send(ENDPOINTS["created"], {**record["session"], "adaptedModel": 1})
            if not isinstance(owned, dict) or owned.get("result") != "success":
                raise HTTPException(409, "xBloom account verification failed; sign in again in Settings")
            if not any(str(raw.get("tableId", raw.get("table_id", raw.get("recipeId")))) == str(table_id)
                       for raw, _ in _candidate_records(owned)):
                raise HTTPException(403, "Recipe does not belong to the saved xBloom account")
        payload = send(body.endpoint, form)
    except CatalogError:
        raise HTTPException(502, "xBloom cloud request failed; retry or sign in again in Settings") from None
    if isinstance(payload, dict) and payload.get("result") not in (None, "success"):
        # Do not retry writes: an upstream failure is not proof that nothing changed.
        raise HTTPException(409, "xBloom cloud rejected the request; sign in again in Settings if it persists")
    return sanitize_public_output(payload)
