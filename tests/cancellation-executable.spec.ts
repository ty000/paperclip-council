import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("journals an obsolete PR close before a lost response, refuses a second effect and preserves branches", () => {
  const result = execFileSync("python3", ["-c", String.raw`
import argparse, pathlib, tempfile, json, sys
sys.path.insert(0,sys.argv[1])
import cancel_delivery as module
args=argparse.Namespace(company_id="company",mission_id="mission")
view={"version":1}
report={"state":"open","url":"https://github.com/ty000/repo/pull/12","repository":"ty000/repo"}
module.report=lambda a,v:dict(report)
effects=[]
def effect(argv,**kwargs):
    assert argv[0:4]==["gh","api","--method","PATCH"]
    assert argv[4]=="repos/ty000/repo/pulls/12"
    assert json.loads(pathlib.Path(argv[-1]).read_text())=={"state":"closed"}
    effects.append(argv)
    return argparse.Namespace(returncode=0)
module.subprocess.run=effect
with tempfile.TemporaryDirectory() as root:
    lost=pathlib.Path(root)/"lost";lost.mkdir()
    def lose(a,p):
        assert (lost/"close-claim.json").exists()
        raise OSError("lost permission")
    module.native=lose
    try:module.close_once(args,view,lost)
    except OSError:pass
    else:raise AssertionError("lost reply must stop")
    module.native=lambda a,p:{"outcome":"applied","effectPermission":"execute"}
    try:module.close_once(args,view,lost)
    except ValueError:pass
    else:raise AssertionError("prepared close cannot repeat")
    assert effects==[]
    ok=pathlib.Path(root)/"ok";ok.mkdir()
    module.close_once(args,view,ok)
    assert len(effects)==1
    assert all(p.stat().st_mode & 0o777==0o600 for p in ok.iterdir())
    try:module.close_once(args,view,ok)
    except ValueError:pass
    else:raise AssertionError("close cannot repeat")
    assert len(effects)==1
    merged=pathlib.Path(root)/"merged";merged.mkdir();report["state"]="merged"
    try:module.close_once(args,view,merged)
    except ValueError:pass
    else:raise AssertionError("integrated commits must be retained")
    assert len(effects)==1 and not list(merged.iterdir())
print("PASS")
`, resolve("scripts/operations")], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" });
  expect(result.trim()).toBe("PASS");
});
