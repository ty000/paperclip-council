import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

describe("guarded publisher integration executable", () => {
  it("journals before a lost claim reply, refuses restart effects and pins a single GitHub request", () => {
    const result = execFileSync("python3", ["-c", String.raw`
import argparse, json, pathlib, sys, tempfile
sys.path.insert(0, sys.argv[1])
import integrate_delivery as module
args=argparse.Namespace(mission_id="mission")
report_args=argparse.Namespace(url="https://github.com/ty000/paperclip-council/pull/123", repository="ty000/paperclip-council", head="a"*40)
view={"version":3,"delivery":{"integration":{},"authority":{"contract":{"integration":{"mergeMethod":"squash"}}}}}
module.github_integration.report=lambda a:{"state":"open"}
module.github_feedback.report=lambda a:{"headCommit":a.head}
effects=[]
def effect(argv, **kwargs):
    assert pathlib.Path(argv[-1]).exists()
    body=json.loads(pathlib.Path(argv[-1]).read_text())
    assert body=={"sha":"a"*40,"merge_method":"squash"}
    effects.append(argv)
    return argparse.Namespace(returncode=0)
module.subprocess.run=effect
with tempfile.TemporaryDirectory() as root:
    lost=pathlib.Path(root)/"lost"; lost.mkdir()
    def lose(a,p):
        assert (lost/"merge-claim.json").exists()
        raise OSError("lost native response")
    module.native=lose
    try: module.merge_once(args,view,report_args,lost)
    except OSError: pass
    else: raise AssertionError("lost reply must stop")
    module.native=lambda a,p:{"effectPermission":"execute","outcome":"applied"}
    try: module.merge_once(args,view,report_args,lost)
    except ValueError: pass
    else: raise AssertionError("prepared claim cannot repeat")
    assert effects==[]
    ok=pathlib.Path(root)/"ok"; ok.mkdir()
    module.merge_once(args,view,report_args,ok)
    assert len(effects)==1
    assert effects[0][0:4]==["gh","api","--method","PUT"]
    assert effects[0][4]=="repos/ty000/paperclip-council/pulls/123/merge"
    assert all(p.stat().st_mode & 0o777 == 0o600 for p in ok.iterdir())
    try: module.merge_once(args,view,report_args,ok)
    except ValueError: pass
    else: raise AssertionError("successful request cannot repeat")
    assert len(effects)==1
    module.current=lambda a:({"version":4,"delivery":{"integration":{"mergeClaimedAt":"now"}}},report_args)
    module.github_integration.report=lambda a:{"state":"merged"}
    module.native=lambda a,p:{"mission":{"aggregate":{"n5":{"integration":{"state":"verified"}}}}}
    assert module.observe(args,ok)["state"]=="verified"
    assert len(effects)==1
print("PASS")
`, resolve("scripts/operations")], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" });
    expect(result.trim()).toBe("PASS");
  });
});
