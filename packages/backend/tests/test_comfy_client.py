import pytest

from src.services.comfy_client import (
    ComfyClient,
    ComfyRejected,
    ComfyUnreachable,
    normalize_address,
    ws_url,
)

from tests.fake_comfy import FakeComfy


def test_addresses():
    assert normalize_address("127.0.0.1:8188/") == "http://127.0.0.1:8188"
    assert ws_url("https://comfy.lan").startswith("wss://comfy.lan/ws?clientId=")


async def test_rest_roundtrip_sends_headers():
    fake = FakeComfy()
    c = ComfyClient(
        "127.0.0.1:8188", {"Authorization": "Bearer t"}, transport=fake.transport()
    )
    assert (await c.system_stats())["system"]["comfyui_version"]
    info = await c.object_info("LoraLoader")
    assert info["LoraLoader"]["input"]["required"]["lora_name"][0] == fake.loras
    assert await c.embeddings() == fake.embedding_names
    pid = await c.queue_prompt({"9": {"class_type": "SaveImage", "inputs": {}}})
    assert await c.queue() == ([], [pid])
    assert await c.history(pid) is None
    assert all(h.get("authorization") == "Bearer t" for h in fake.headers_seen)
    await c.aclose()


async def test_rejected_prompt_flattens_node_errors():
    fake = FakeComfy()
    fake.reject_next = {
        "error": {
            "type": "prompt_outputs_failed_validation",
            "message": "Prompt outputs failed validation",
        },
        "node_errors": {
            "4": {
                "class_type": "CheckpointLoaderSimple",
                "dependent_outputs": ["9"],
                "errors": [
                    {
                        "type": "value_not_in_list",
                        "message": "Value not in list",
                        "details": "ckpt_name: 'x' not in [...]",
                        "extra_info": {"input_name": "ckpt_name"},
                    }
                ],
            }
        },
    }
    c = ComfyClient("http://fake", transport=fake.transport())
    with pytest.raises(ComfyRejected) as e:
        await c.queue_prompt({})
    assert e.value.message == "Prompt outputs failed validation"
    assert e.value.node_errors == [
        {
            "node": "4",
            "class_type": "CheckpointLoaderSimple",
            "type": "value_not_in_list",
            "message": "Value not in list",
            "details": "ckpt_name: 'x' not in [...]",
            "input": "ckpt_name",
        }
    ]


async def test_down_raises_unreachable():
    fake = FakeComfy()
    fake.up = False
    c = ComfyClient("http://fake", transport=fake.transport())
    with pytest.raises(ComfyUnreachable):
        await c.system_stats()


async def test_events_skip_binary_and_report_state():
    fake = FakeComfy()
    states = []
    c = ComfyClient("http://fake", transport=fake.transport())
    fake.ws_queue.put_nowait(b"\x00preview")  # type: ignore[arg-type]
    fake.push("status", {"status": {"exec_info": {"queue_remaining": 2}}})
    gen = c.events(connect=fake.connect, on_state=states.append)
    msg = await gen.__anext__()
    assert msg["type"] == "status"
    assert states == [True]
    await gen.aclose()
    assert states == [True, False]
