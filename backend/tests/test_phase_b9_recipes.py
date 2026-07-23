"""Phase B9 typed SQLite recipe CRUD and design-save tests.

No BLE, no bridge network. Uses a temp XBLOOM_STATE_DIR and optional
XBLOOM_ASSETS_DIR. Run from backend/:

    python -m pytest tests/test_phase_b9_recipes.py -q
"""

from __future__ import annotations

import copy
import hashlib
import json
import threading
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from xbloom_storage import content_sha256, open_store

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent
SKILL_ASSETS = (
    REPO_ROOT.parent
    / "xbloom-studio-brew"
    / "skills"
    / "xbloom-studio-brew"
    / "assets"
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


VALID_COFFEE: dict[str, Any] = {
    "name": "B9 Ethiopia Washed",
    "kind": "hot",
    "dripper": "Omni Dripper 2",
    "dose_g": 15,
    "grind": 58,
    "ratio": 16,
    "water_ml": 240,
    "hot_water_ml": 240,
    "time": "2:30-3:00",
    "note": "B9 unit-test candidate",
    "pours": [
        {
            "label": "Bloom",
            "ml": 45,
            "temp_c": 92,
            "pattern": "spiral",
            "vibration": "after",
            "pause_s": 35,
            "rpm": 90,
            "flow_ml_s": 3.0,
        },
        {
            "label": "Main",
            "ml": 105,
            "temp_c": 92,
            "pattern": "spiral",
            "vibration": "none",
            "pause_s": 10,
            "rpm": 90,
            "flow_ml_s": 3.2,
        },
        {
            "label": "Finish",
            "ml": 90,
            "temp_c": 91,
            "pattern": "circular",
            "vibration": "none",
            "pause_s": 0,
            "rpm": 90,
            "flow_ml_s": 3.2,
        },
    ],
}


def _coffee(**overrides: Any) -> dict[str, Any]:
    data = copy.deepcopy(VALID_COFFEE)
    data.update(overrides)
    return data


def _design_style_hash(candidate: dict[str, Any]) -> str:
    payload = json.dumps(
        candidate, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _b7_provenance(
    candidate: dict[str, Any],
    *,
    used_image: bool = True,
    used_ocr: bool = False,
    repaired: bool = False,
    knowledge_source: str = "bundle",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Actual B7 design provenance shape (bundle/dev_root + used_image)."""

    prov: dict[str, Any] = {
        "provider": "openai-compatible",
        "model": "grok-4.5-test",
        "knowledge_version": "1.2.0-test",
        "knowledge_content_hash": "a" * 64,
        "knowledge_source": knowledge_source,
        "prompt_template_version": "design-prompt-v1",
        "schema_version": "recipe-design-output-v1",
        "candidate_hash": _design_style_hash(candidate),
        "design_mode": "vision",
        "repaired": repaired,
        "used_image": used_image,
        "used_ocr": used_ocr,
    }
    if extra:
        prov.update(extra)
    return prov


def _assert_error_category(resp: Any, category: str) -> None:
    detail = resp.json()["detail"]
    assert isinstance(detail, dict), detail
    assert detail.get("category") == category, detail
    assert "message" in detail
    assert "error" not in detail


@pytest.fixture(autouse=True)
def _isolated_state_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    state = tmp_path / "xbloom-state"
    state.mkdir()
    monkeypatch.setenv("XBLOOM_STATE_DIR", str(state))
    # Avoid accidental assets unless a test opts in.
    monkeypatch.delenv("XBLOOM_ASSETS_DIR", raising=False)
    return state


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Any:
    """FastAPI TestClient with bridge ensure mocked (no real daemon).

    Builds a fresh app via create_app so host LAN/design env cannot leak through
    the import-time main.app snapshot.
    """

    state = tmp_path / "client-state"
    state.mkdir(exist_ok=True)
    monkeypatch.setenv("XBLOOM_STATE_DIR", str(state))
    monkeypatch.setenv("XBLOOM_WEB_MODE", "loopback")

    with patch(
        "main.ensure_bridge_daemon",
        return_value={"status": "ok", "client_ready": True},
    ):
        from main import create_app

        app = create_app()
        with TestClient(app) as tc:
            yield tc


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------


def test_main_registers_every_recipe_route(client: TestClient) -> None:
    paths = {getattr(r, "path", None) for r in client.app.routes}
    expected = {
        "/api/recipes/templates",
        "/api/recipes/validate",
        "/api/recipes/from-design",
        "/api/recipes",
        "/api/recipes/",
        "/api/recipes/{recipe_id}",
        "/api/recipes/{recipe_id}/revisions",
        "/api/recipes/{recipe_id}/archive",
        "/api/recipes/{recipe_id}/restore",
    }
    missing = expected - paths
    assert not missing, f"missing routes: {missing}; have={sorted(p for p in paths if p and 'recipe' in p)}"


# ---------------------------------------------------------------------------
# Create / get / list / history / edit
# ---------------------------------------------------------------------------


def test_create_get_list_history_edit(client: TestClient) -> None:
    create = client.post(
        "/api/recipes",
        json={
            "content": VALID_COFFEE,
            "name": "B9 Hot",
            "tags": ["b9", "washed"],
            "provenance": {"note": "manual create"},
        },
    )
    assert create.status_code == 200, create.text
    body = create.json()
    recipe = body["recipe"]
    rev = body["revision"]
    rid = recipe["recipe_id"]
    assert recipe["name"] == "B9 Hot"
    assert recipe["kind"] == "coffee"
    assert recipe["source"] == "web"
    assert recipe["metadata"]["tags"] == ["b9", "washed"]
    assert rev["revision_number"] == 1
    assert rev["parent_revision_id"] is None
    assert rev["provenance"].get("creation_source") == "web"
    assert rev["content"]["dose_g"] == 15

    got = client.get(f"/api/recipes/{rid}")
    assert got.status_code == 200
    got_body = got.json()
    assert got_body["recipe"]["recipe_id"] == rid
    assert got_body["latest_revision"]["revision_id"] == rev["revision_id"]
    assert got_body["latest_revision"]["content"]["name"] == "B9 Ethiopia Washed"

    listed = client.get("/api/recipes", params={"kind": "coffee", "query": "B9"})
    assert listed.status_code == 200
    listed_body = listed.json()
    assert listed_body["count"] >= 1
    assert any(r["recipe_id"] == rid for r in listed_body["recipes"])
    assert listed_body["recipes"][0]["latest_revision"] is not None

    # kind is typed to coffee|tea - other values are rejected.
    bad_kind = client.get("/api/recipes", params={"kind": "hot"})
    assert bad_kind.status_code == 422

    hist = client.get(f"/api/recipes/{rid}/revisions")
    assert hist.status_code == 200
    hist_body = hist.json()
    assert hist_body["count"] == 1
    assert hist_body["revisions"][0]["revision_id"] == rev["revision_id"]

    edited_content = _coffee(name="B9 Hot v2", note="tweaked grind")
    edit = client.post(
        f"/api/recipes/{rid}/revisions",
        json={
            "content": edited_content,
            "expected_parent_revision_id": rev["revision_id"],
            "name": "B9 Hot v2",
            "tags": ["b9", "v2"],
        },
    )
    assert edit.status_code == 200, edit.text
    edit_body = edit.json()
    assert edit_body["revision"]["revision_number"] == 2
    assert edit_body["revision"]["parent_revision_id"] == rev["revision_id"]
    assert edit_body["recipe"]["name"] == "B9 Hot v2"
    assert edit_body["recipe"]["source"] == "web"
    assert edit_body["recipe"]["metadata"]["tags"] == ["b9", "v2"]

    hist2 = client.get(f"/api/recipes/{rid}/revisions")
    assert hist2.json()["count"] == 2
    numbers = [r["revision_number"] for r in hist2.json()["revisions"]]
    assert numbers == [1, 2]


def test_get_and_history_unknown_404(client: TestClient) -> None:
    r1 = client.get("/api/recipes/rcp_does_not_exist")
    assert r1.status_code == 404
    _assert_error_category(r1, "not_found")

    r2 = client.get("/api/recipes/rcp_does_not_exist/revisions")
    assert r2.status_code == 404
    _assert_error_category(r2, "not_found")


# ---------------------------------------------------------------------------
# Archive / restore
# ---------------------------------------------------------------------------


def test_archive_and_restore(client: TestClient) -> None:
    created = client.post("/api/recipes", json={"content": VALID_COFFEE}).json()
    rid = created["recipe"]["recipe_id"]
    rev_id = created["revision"]["revision_id"]

    arch = client.post(
        f"/api/recipes/{rid}/archive",
        json={"expected_latest_revision_id": rev_id},
    )
    assert arch.status_code == 200, arch.text
    assert arch.json()["recipe"]["archived_at"] is not None

    active = client.get("/api/recipes")
    assert all(r["recipe_id"] != rid for r in active.json()["recipes"])

    with_arch = client.get("/api/recipes", params={"include_archived": True})
    assert any(r["recipe_id"] == rid for r in with_arch.json()["recipes"])

    rest = client.post(
        f"/api/recipes/{rid}/restore",
        json={"expected_latest_revision_id": rev_id},
    )
    assert rest.status_code == 200, rest.text
    assert rest.json()["recipe"]["archived_at"] is None

    active2 = client.get("/api/recipes")
    assert any(r["recipe_id"] == rid for r in active2.json()["recipes"])


def test_archive_stale_guard_409(client: TestClient) -> None:
    created = client.post("/api/recipes", json={"content": VALID_COFFEE}).json()
    rid = created["recipe"]["recipe_id"]
    rev_id = created["revision"]["revision_id"]

    # Advance revision so archive with old expected id is stale.
    client.post(
        f"/api/recipes/{rid}/revisions",
        json={
            "content": _coffee(name="advanced"),
            "expected_parent_revision_id": rev_id,
        },
    )
    stale = client.post(
        f"/api/recipes/{rid}/archive",
        json={"expected_latest_revision_id": rev_id},
    )
    assert stale.status_code == 409
    _assert_error_category(stale, "conflict")


def test_archive_unknown_404(client: TestClient) -> None:
    resp = client.post(
        "/api/recipes/rcp_missing/archive",
        json={"expected_latest_revision_id": "rev_x"},
    )
    assert resp.status_code == 404
    _assert_error_category(resp, "not_found")


# ---------------------------------------------------------------------------
# Concurrent OCC: real simultaneous HTTP race (two threads + barrier)
# ---------------------------------------------------------------------------


def test_stale_concurrent_edits_one_success_one_409(
    client: TestClient, _isolated_state_dir: Path
) -> None:
    created = client.post("/api/recipes", json={"content": VALID_COFFEE}).json()
    rid = created["recipe"]["recipe_id"]
    parent = created["revision"]["revision_id"]

    body_a = {
        "content": _coffee(name="Concurrent A", note="race-a"),
        "expected_parent_revision_id": parent,
    }
    body_b = {
        "content": _coffee(name="Concurrent B", note="race-b"),
        "expected_parent_revision_id": parent,
    }

    barrier = threading.Barrier(2)
    results: dict[str, Any] = {}
    errors: dict[str, BaseException] = {}
    state_dir = str(_isolated_state_dir)

    def worker(label: str, payload: dict[str, Any]) -> None:
        try:
            # Independent client / connection against the same temp SQLite state.
            with patch(
                "main.ensure_bridge_daemon",
                return_value={"status": "ok", "client_ready": True},
            ):
                from main import create_app
                app = create_app()

                with TestClient(app) as tc:
                    barrier.wait(timeout=10)
                    results[label] = tc.post(
                        f"/api/recipes/{rid}/revisions", json=payload
                    )
        except BaseException as exc:  # noqa: BLE001 - surface thread failures
            errors[label] = exc

    # Ensure both workers see the isolated state dir (process env is shared).
    assert Path(state_dir).is_dir()

    t_a = threading.Thread(target=worker, args=("a", body_a), name="b9-race-a")
    t_b = threading.Thread(target=worker, args=("b", body_b), name="b9-race-b")
    t_a.start()
    t_b.start()
    t_a.join(timeout=30)
    t_b.join(timeout=30)
    assert not t_a.is_alive() and not t_b.is_alive(), "race workers did not finish"
    assert not errors, f"worker errors: {errors}"

    r1 = results["a"]
    r2 = results["b"]
    statuses = sorted([r1.status_code, r2.status_code])
    assert statuses == [200, 409], (r1.status_code, r1.text, r2.status_code, r2.text)

    winner = r1 if r1.status_code == 200 else r2
    loser = r2 if r1.status_code == 200 else r1
    assert winner.json()["revision"]["revision_number"] == 2
    _assert_error_category(loser, "conflict")

    winner_name = winner.json()["revision"]["content"]["name"]
    assert winner_name in {"Concurrent A", "Concurrent B"}

    hist = client.get(f"/api/recipes/{rid}/revisions").json()
    assert hist["count"] == 2
    assert hist["revisions"][-1]["content"]["name"] == winner_name


# ---------------------------------------------------------------------------
# Design save
# ---------------------------------------------------------------------------


def test_from_design_with_b7_provenance_used_image(client: TestClient) -> None:
    candidate = _coffee(name="Design Ethiopia")
    provenance = _b7_provenance(candidate, used_image=True, used_ocr=False)

    resp = client.post(
        "/api/recipes/from-design",
        json={
            "recipe_candidate": candidate,
            "design_rationale": "Balanced hot baseline for washed light roast.",
            "evidence": [
                {
                    "source": "user_text",
                    "claim": "User asked for Ethiopia washed",
                    "value": "ethiopia",
                },
                {
                    "source": "bag_label",
                    "claim": "Label mentions washed process",
                },
            ],
            "provenance": provenance,
            "tags": ["design", "ethiopia"],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    recipe = body["recipe"]
    rev = body["revision"]
    assert recipe["source"] == "web-design"
    assert recipe["metadata"]["tags"] == ["design", "ethiopia"]
    prov = rev["provenance"]
    assert prov["creation_source"] == "web-design"
    assert prov["provider"] == "openai-compatible"
    assert prov["model"] == "grok-4.5-test"
    assert prov["knowledge_version"] == "1.2.0-test"
    assert prov["knowledge_content_hash"]
    assert prov["knowledge_source"] == "bundle"
    assert prov["prompt_template_version"]
    assert prov["schema_version"]
    assert prov["candidate_hash"] == provenance["candidate_hash"]
    assert prov["used_image"] is True
    assert prov["used_ocr"] is False
    assert prov["design_mode"] == "vision"
    assert prov["repaired"] is False
    assert prov["design_rationale"].startswith("Balanced hot")
    assert isinstance(prov["evidence"], list) and len(prov["evidence"]) == 2
    assert prov["saved_candidate_hash"]
    assert prov["candidate_modified"] is False
    # No image material / secrets.
    dumped = json.dumps(body)
    assert "image_base64" not in dumped
    assert "api_key" not in dumped
    assert "raw_image" not in dumped


def test_from_design_edited_candidate_hash_provenance(client: TestClient) -> None:
    original = _coffee(name="Original Design")
    original_hash = _design_style_hash(original)
    # User edits after design: change note/name while keeping provider candidate_hash.
    # Keep dose/water/pours consistent so design validation still accepts the candidate.
    edited = _coffee(name="Original Design (edited)", note="user tweaked note")
    assert _design_style_hash(edited) != original_hash

    provenance = _b7_provenance(original, used_image=True)
    assert provenance["candidate_hash"] == original_hash

    resp = client.post(
        "/api/recipes/from-design",
        json={
            "recipe_candidate": edited,
            "design_rationale": "User adjusted note after generation.",
            "evidence": [
                {
                    "source": "user_text",
                    "claim": "User edited the generated candidate",
                }
            ],
            "provenance": provenance,
        },
    )
    assert resp.status_code == 200, resp.text
    prov = resp.json()["revision"]["provenance"]
    # Provider hash preserved; edits are explicit.
    assert prov["candidate_hash"] == original_hash
    assert prov["candidate_modified"] is True
    assert prov["saved_candidate_hash"]
    # saved_candidate_hash matches content_sha256 of stored content
    stored = resp.json()["revision"]["content"]
    assert prov["saved_candidate_hash"] == content_sha256(stored)
    assert prov["saved_candidate_hash"] != original_hash


def test_from_design_rejects_invalid_design_document(client: TestClient) -> None:
    """Strict B5/B6 design contract: schema / additional props / field errors."""

    candidate = _coffee()
    # Extra property on candidate is stripped by allowlist, but missing
    # design_rationale / bad evidence source is schema-rejected.
    missing_rationale = client.post(
        "/api/recipes/from-design",
        json={
            "recipe_candidate": candidate,
            "design_rationale": "",
            "evidence": [{"source": "user_text", "claim": "x"}],
            "provenance": _b7_provenance(candidate),
        },
    )
    assert missing_rationale.status_code == 422

    bad_evidence = client.post(
        "/api/recipes/from-design",
        json={
            "recipe_candidate": candidate,
            "design_rationale": "ok rationale",
            "evidence": [{"source": "not-a-real-source", "claim": "x"}],
            "provenance": _b7_provenance(candidate),
        },
    )
    # evidence source enum is schema-level; may be 400 (design validation) after model.
    assert bad_evidence.status_code in {400, 422}, bad_evidence.text

    # Core-invalid pours: design validation returns field errors as 400.
    broken = _coffee()
    broken["pours"] = [{"label": "only-one", "ml": 10}]  # too few / incomplete
    core_bad = client.post(
        "/api/recipes/from-design",
        json={
            "recipe_candidate": broken,
            "design_rationale": "would not pass core",
            "evidence": [{"source": "user_text", "claim": "broken pours"}],
            "provenance": _b7_provenance(broken),
        },
    )
    assert core_bad.status_code == 400, core_bad.text
    _assert_error_category(core_bad, "validation")

    # knowledge_source must be bundle|dev_root.
    bad_source = client.post(
        "/api/recipes/from-design",
        json={
            "recipe_candidate": candidate,
            "design_rationale": "ok",
            "evidence": [{"source": "user_text", "claim": "x"}],
            "provenance": _b7_provenance(
                candidate, extra={"knowledge_source": "XBLOOM_KNOWLEDGE_DIR"}
            ),
        },
    )
    assert bad_source.status_code == 422

    # candidate_hash must be SHA-256 hex.
    bad_hash = client.post(
        "/api/recipes/from-design",
        json={
            "recipe_candidate": candidate,
            "design_rationale": "ok",
            "evidence": [{"source": "user_text", "claim": "x"}],
            "provenance": _b7_provenance(
                candidate, extra={"candidate_hash": "not-a-sha256"}
            ),
        },
    )
    assert bad_hash.status_code == 422


def test_forbidden_provenance_rejected_no_db_write(
    client: TestClient, _isolated_state_dir: Path
) -> None:
    before = client.get("/api/recipes").json()["count"]

    # Forbidden keys on ordinary create (browser-unsafe request model -> 422).
    bad = client.post(
        "/api/recipes",
        json={
            "content": VALID_COFFEE,
            "provenance": {
                "image_base64": "AAAA",
                "model": "x",
            },
        },
    )
    assert bad.status_code == 422, bad.text

    bad2 = client.post(
        "/api/recipes",
        json={
            "content": VALID_COFFEE,
            "provenance": {"reasoning": "step by step chain of thought"},
        },
    )
    assert bad2.status_code == 422

    bad3 = client.post(
        "/api/recipes",
        json={
            "content": VALID_COFFEE,
            "provenance": {"local_path": "C:/Users/secret/bean.jpg"},
        },
    )
    assert bad3.status_code == 422
    # 422 may echo request input; the guarantee is no storage write (checked below).

    # Forbidden extra fields on design provenance body (extra=forbid).
    candidate = _coffee()
    forbidden_design = client.post(
        "/api/recipes/from-design",
        json={
            "recipe_candidate": candidate,
            "design_rationale": "ok",
            "evidence": [{"source": "user_text", "claim": "x"}],
            "provenance": {
                **_b7_provenance(candidate),
                "image_base64": "AAAA",
            },
        },
    )
    assert forbidden_design.status_code == 422  # pydantic extra forbid / unsafe key

    after = client.get("/api/recipes").json()["count"]
    assert after == before

    # Confirm SQLite has no recipes.
    store = open_store()
    try:
        assert store.list_recipes() == []
    finally:
        store.close()


def test_path_strings_in_allowed_fields_are_422_never_written(
    client: TestClient, _isolated_state_dir: Path
) -> None:
    """Allowed note/tag/name/rationale/evidence strings must not carry local paths."""

    before = client.get("/api/recipes").json()["count"]
    win_path = "C:/Users/secret/recipe-notes.txt"
    posix_path = "/home/secret/bean-notes.txt"

    cases: list[tuple[str, dict[str, Any]]] = [
        (
            "create note",
            {
                "url": "/api/recipes",
                "json": {"content": _coffee(note=f"see {win_path}")},
            },
        ),
        (
            "create tags",
            {
                "url": "/api/recipes",
                "json": {"content": VALID_COFFEE, "tags": [f"from:{posix_path}"]},
            },
        ),
        (
            "create name",
            {
                "url": "/api/recipes",
                "json": {"content": VALID_COFFEE, "name": win_path},
            },
        ),
        (
            "validate note",
            {
                "url": "/api/recipes/validate",
                "json": {"content": _coffee(note=posix_path)},
            },
        ),
        (
            "from-design rationale",
            {
                "url": "/api/recipes/from-design",
                "json": {
                    "recipe_candidate": _coffee(),
                    "design_rationale": f"Based on {win_path}",
                    "evidence": [{"source": "user_text", "claim": "x"}],
                    "provenance": _b7_provenance(_coffee()),
                },
            },
        ),
        (
            "from-design evidence",
            {
                "url": "/api/recipes/from-design",
                "json": {
                    "recipe_candidate": _coffee(),
                    "design_rationale": "ok rationale",
                    "evidence": [
                        {
                            "source": "user_text",
                            "claim": f"Label path {posix_path}",
                        }
                    ],
                    "provenance": _b7_provenance(_coffee()),
                },
            },
        ),
        (
            "create provenance.note",
            {
                "url": "/api/recipes",
                "json": {
                    "content": VALID_COFFEE,
                    "provenance": {"note": f"copied from {win_path}"},
                },
            },
        ),
    ]

    for label, case in cases:
        resp = client.post(case["url"], json=case["json"])
        assert resp.status_code == 422, f"{label}: {resp.status_code} {resp.text}"
        _assert_error_category(resp, "validation")
        assert win_path not in resp.text, label
        assert posix_path not in resp.text, label

    after = client.get("/api/recipes").json()["count"]
    assert after == before

    store = open_store()
    try:
        recipes = store.list_recipes(include_archived=True)
        assert recipes == []
        # Also ensure no revision content contains the path strings.
        for recipe in recipes:
            rid = recipe["recipe_id"]
            for rev in store.list_recipe_revisions(rid):
                blob = json.dumps(rev)
                assert win_path not in blob
                assert posix_path not in blob
    finally:
        store.close()


def test_allowed_safe_field_names_not_false_positive(client: TestClient) -> None:
    """Whole-token matching must not reject candidate_hash / used_image / pathway."""

    created = client.post(
        "/api/recipes",
        json={
            "content": VALID_COFFEE,
            "provenance": {
                "candidate_hash": "b" * 64,
                "tokenizer": "tiktoken",
                "pathway": "web",
                "source_url": "https://example.com/bag",
                "used_image": True,
                "parent_revision_id": "ignored-by-sanitizer",
            },
        },
    )
    assert created.status_code == 200, created.text
    prov = created.json()["revision"]["provenance"]
    assert prov.get("candidate_hash") == "b" * 64
    assert prov.get("used_image") is True
    assert prov.get("tokenizer") == "tiktoken"
    assert prov.get("pathway") == "web"
    assert prov.get("source_url") == "https://example.com/bag"


# ---------------------------------------------------------------------------
# Templates (no path leakage)
# ---------------------------------------------------------------------------


def test_templates_no_path_leakage(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    if not SKILL_ASSETS.is_dir():
        pytest.skip("skill assets not available next to workspace")
    monkeypatch.setenv("XBLOOM_ASSETS_DIR", str(SKILL_ASSETS))

    resp = client.get("/api/recipes/templates")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "assets_dir" not in body
    assert "hint" not in body
    templates = body["templates"]
    assert len(templates) >= 1

    raw = resp.text
    # No absolute path / assets dir leakage.
    assert str(SKILL_ASSETS) not in raw
    assert "C:\\" not in raw and "C:/" not in raw
    for t in templates:
        assert "file" not in t
        assert "path" not in t
        assert "assets_dir" not in t
        assert "template_id" in t
        assert "name" in t
        assert "kind" in t
        assert "content" in t
        assert isinstance(t["content"], dict)
        assert "pours" in t  # summary field
        # Content is core-canonical.
        assert t["content"].get("name")

    # bean-input.yaml must not appear (fails core validation).
    ids = {t["template_id"] for t in templates}
    assert "bean-input" not in ids
    assert "hot-template" in ids or any("hot" in i for i in ids)


def test_templates_empty_without_assets(client: TestClient) -> None:
    resp = client.get("/api/recipes/templates")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"templates": []}
    assert "assets_dir" not in body


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def test_validate_content_ok_and_reject_path(client: TestClient) -> None:
    ok = client.post("/api/recipes/validate", json={"content": VALID_COFFEE})
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["valid"] is True
    assert body["kind"] == "hot"
    assert body["content"]["dose_g"] == 15
    assert "path" not in body

    # Path-only body: content required + path forbidden by extra=forbid / unsafe key.
    path_only = client.post(
        "/api/recipes/validate",
        json={"path": "C:/Users/someone/recipe.yaml"},
    )
    assert path_only.status_code == 422
    _assert_error_category(path_only, "validation")
    assert "C:/Users/someone" not in path_only.text

    # Path alongside content still rejected (extra forbid / unsafe key).
    path_extra = client.post(
        "/api/recipes/validate",
        json={"content": VALID_COFFEE, "path": "C:/Users/someone/recipe.yaml"},
    )
    assert path_extra.status_code == 422
    _assert_error_category(path_extra, "validation")
    assert "C:/Users/someone" not in path_extra.text

    # Invalid content structure -> valid=false, no path leak.
    bad = client.post(
        "/api/recipes/validate",
        json={"content": {"name": "x", "kind": "hot", "dose_g": 15, "pours": []}},
    )
    assert bad.status_code == 200
    bad_body = bad.json()
    assert bad_body["valid"] is False
    assert bad_body["error"]["category"] == "validation"
    assert "C:" not in bad.text


def test_create_rejects_extra_and_path_fields(client: TestClient) -> None:
    resp = client.post(
        "/api/recipes",
        json={
            "content": VALID_COFFEE,
            "source": "spoofed",
            "metadata": {"evil": True},
        },
    )
    assert resp.status_code == 422

    resp2 = client.post(
        "/api/recipes",
        json={"content": VALID_COFFEE, "path": "C:/secret.yaml"},
    )
    assert resp2.status_code == 422


def test_archive_requires_expected_latest(client: TestClient) -> None:
    created = client.post("/api/recipes", json={"content": VALID_COFFEE}).json()
    rid = created["recipe"]["recipe_id"]
    missing = client.post(f"/api/recipes/{rid}/archive", json={})
    assert missing.status_code == 422
