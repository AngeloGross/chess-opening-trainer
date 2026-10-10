import pytest

from opening_trainer.cli import build_parser, select_games

PERFS = {"blitz", "rapid", "classical"}


def _g(i, ts, perf="blitz", variant="standard"):
    return {"id": str(i), "createdAt": ts, "perf": perf, "variant": variant}


GAMES = [_g(1, 100), _g(2, 300), _g(3, 200), _g(4, 400, perf="bullet"), _g(5, 500, variant="chess960"), _g(6, 50)]


def test_select_most_recent_matching_games():
    assert [g["id"] for g in select_games(GAMES, PERFS, None, 2)] == ["2", "3"]


def test_select_all():
    assert [g["id"] for g in select_games(GAMES, PERFS, None, None)] == ["2", "3", "1", "6"]


def test_select_since():
    assert [g["id"] for g in select_games(GAMES, PERFS, 150, None)] == ["2", "3"]
    assert [g["id"] for g in select_games(GAMES, PERFS, 150, 1)] == ["2"]


@pytest.mark.parametrize(
    "argv",
    [
        ["analyse", "--depth", "0"],
        ["analyse", "--max-moves", "0"],
        ["analyse", "--book-moves", "-1"],
        ["analyse", "--threshold", "-5"],
        ["fetch", "--max-games", "0"],
        ["fetch", "--since", "2024-13-01"],
        ["serve", "--port", "70000"],
        ["serve", "--port", "0"],
    ],
)
def test_invalid_options_are_rejected(argv):
    with pytest.raises(SystemExit):
        build_parser().parse_args(argv)


def test_valid_options_parse():
    args = build_parser().parse_args(["update", "--depth", "12", "--max-games", "50", "--since", "2024-01-01"])
    assert (args.depth, args.max_games, args.since) == (12, 50, 1704067200000)
    assert (args.max_moves, args.book_moves) == (12, 10)
    assert build_parser().parse_args(["analyse", "--book-moves", "0"]).book_moves == 0


def test_serve_sends_wasm_as_application_wasm():
    # WebAssembly.instantiateStreaming needs this type (the engine worker falls back otherwise).
    from opening_trainer.cli import _Handler

    assert _Handler.extensions_map[".wasm"] == "application/wasm"


def test_serve_sends_mjs_as_javascript():
    # Module scripts with a non-JavaScript type are refused (the vendored QR code library is an .mjs file).
    from opening_trainer.cli import _Handler

    assert _Handler.extensions_map[".mjs"] == "text/javascript"


def test_serve_defaults_to_this_computer_only():
    args = build_parser().parse_args(["serve"])
    assert args.host == "127.0.0.1"


def test_serve_urls():
    from opening_trainer.cli import serve_urls

    assert serve_urls("127.0.0.1", 8000, ["192.168.1.23"]) == ["http://127.0.0.1:8000/"]
    assert serve_urls("0.0.0.0", 8000, ["192.168.1.23", "10.0.0.5"]) == [
        "http://127.0.0.1:8000/", "http://192.168.1.23:8000/", "http://10.0.0.5:8000/"]
    assert serve_urls("192.168.1.23", 9000, []) == ["http://192.168.1.23:9000/"]


def test_serve_asks_browsers_to_revalidate(tmp_path):
    import functools
    import http.client
    import threading

    from opening_trainer.cli import _Handler, _Server

    (tmp_path / "index.html").write_text("<p>hi</p>", encoding="utf-8")
    handler = functools.partial(_Handler, directory=str(tmp_path))
    with _Server(("127.0.0.1", 0), handler) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/index.html")
            resp = conn.getresponse()
            assert resp.status == 200
            assert resp.getheader("Cache-Control") == "no-cache"
        finally:
            server.shutdown()
