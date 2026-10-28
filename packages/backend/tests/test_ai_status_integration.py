"""Integration test for the assembled AI status view: confirms the route stitches
the tagger + download managers into one object with the settings' target."""


async def test_ai_status_assembles_model_view(client):
    resp = await client.get("/ai/status")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert {"model", "model_load", "model_download", "jobs", "settings"} <= set(body)
    # The download view is reported for the settings' target (repo + cache dir).
    assert body["model_download"]["model_repo"] == body["settings"]["model_repo"]
    assert body["model_download"]["cache_dir"] == body["settings"]["cache_dir"]
