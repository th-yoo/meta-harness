from pathlib import Path
import runner


def test_bench_work_paths_nest_under_root():
    p = runner.bench_work_paths(Path("/w"))
    assert p["app"] == Path("/w/app")
    assert p["tests"] == Path("/w/tests")
    assert p["logs"] == Path("/w/logs/verifier")
    assert p["tmp"] == Path("/w/tmp")
    assert p["extras"] == Path("/w/extras")


def test_default_work_is_bench_prefix():
    # unset env → BENCH_WORK == BENCH_PREFIX (back-compat)
    assert runner.BENCH_WORK == runner.BENCH_PREFIX
    assert runner.REAL_APP == runner.BENCH_PREFIX / "app"


def test_env_override_relocates_writable_but_not_bin(tmp_path):
    import subprocess, sys
    code = ("import runner;"
            "print(str(runner.REAL_APP)+'|'+str(runner.REAL_TMP)+'|'+str(runner.BENCH_BIN))")
    env = {**__import__('os').environ, "MH_BENCH_WORK": str(tmp_path / "w")}
    out = subprocess.check_output([sys.executable, "-c", code],
                                  cwd=Path(runner.__file__).parent, env=env, text=True).strip()
    app, tmp, binp = out.split("|")
    assert app == str(tmp_path / "w" / "app")            # writable → relocated
    assert tmp == str(tmp_path / "w" / "tmp")
    assert binp.endswith("/bench/bin")                   # BENCH_BIN shared → unchanged


def test_real_follows_bench_work(tmp_path, monkeypatch):
    # architect C1: _real()/clean_dir must target BENCH_WORK, not BENCH_PREFIX
    monkeypatch.setattr(runner, "REAL_APP", tmp_path / "w" / "app")
    monkeypatch.setattr(runner, "REAL_TESTS", tmp_path / "w" / "tests")
    monkeypatch.setattr(runner, "REAL_LOGS", tmp_path / "w" / "logs" / "verifier")
    assert runner._real(Path("/app/x")) == tmp_path / "w" / "app" / "x"
    assert runner._real(Path("/tests")) == tmp_path / "w" / "tests"
    assert runner._real(Path("/logs/verifier")) == tmp_path / "w" / "logs" / "verifier"
    assert runner._real(Path("/other")) == Path("/other")   # pass-through unchanged


def test_ensure_localbin_builds_symlink_farm(tmp_path, monkeypatch):
    # architect I2/Task2: farm mirrors /usr/local/bin as symlinks → shadow, no copy
    farm = tmp_path / "localbin"
    monkeypatch.setattr(runner, "LOCALBIN_FARM", farm)
    runner.ensure_localbin()
    real_bin = Path("/usr/local/bin")
    if not real_bin.exists():
        import pytest
        pytest.skip("no /usr/local/bin on this host")
    for entry in real_bin.iterdir():
        link = farm / entry.name
        assert link.is_symlink(), f"{link} should be a symlink"
        assert str(link.readlink()) == f"{runner.ULOCAL_SHADOW}/bin/{entry.name}"
        assert not link.is_file() or link.is_symlink()   # no real file copy


def test_ns_wrap_rejects_non_home_work(monkeypatch):
    # M1: building a sandbox with a non-$HOME MH_BENCH_WORK must die clearly
    import pytest
    monkeypatch.setattr(runner, "BENCH_WORK", Path("/tmp/not-home-xyz"))
    with pytest.raises(SystemExit):
        runner.ns_wrap(["true"])


def test_ns_wrap_allows_home_work(monkeypatch):
    # a $HOME-rooted work dir builds args without dying
    monkeypatch.setattr(runner, "BENCH_WORK", Path.home() / "bench-test-zzz")
    args = runner.ns_wrap(["true"])
    assert args[0] == "bwrap" and args[-1] == "true"


def test_reset_localbin_drops_extras_restores_base(tmp_path, monkeypatch):
    farm = tmp_path / "localbin"
    monkeypatch.setattr(runner, "LOCALBIN_FARM", farm)
    runner.ensure_localbin()
    base = sorted(p.name for p in farm.iterdir())
    (farm / "task-added-sqlite3").symlink_to("/whatever")   # simulate an install
    assert (farm / "task-added-sqlite3").is_symlink()
    runner.reset_localbin()
    after = sorted(p.name for p in farm.iterdir())
    assert "task-added-sqlite3" not in after   # dropped
    assert after == base                        # base farm restored
