from moire.services.generator_graph import bypass_loras, drop_missing


def test_a_node_with_null_inputs_does_not_crash_the_graph_walks():
    graph = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
        "2": {
            "class_type": "LoraLoader",
            "inputs": {"model": ["1", 0], "clip": ["1", 1]},
        },
        "3": {"class_type": "Note", "inputs": None},
        "4": {"class_type": "SaveImage", "inputs": {"images": ["2", 0]}},
    }
    assert drop_missing(graph, {"Note"}) == []
    assert "3" not in graph
    graph["3"] = {"class_type": "Note", "inputs": None}
    assert bypass_loras(graph, ["2"], [["2", 0]]) == [["1", 0]]
    assert graph["4"]["inputs"]["images"] == ["1", 0]
