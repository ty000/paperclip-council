import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

describe("guarded publisher integration executable", () => {
  it("waits only for explicit pre-effect source replies with identical bytes and a finite deadline", () => {
    const result = execFileSync("python3", ["-c", String.raw`
import argparse, io, json, os, pathlib, sys, tempfile, urllib.error
sys.path.insert(0, sys.argv[1])
import integrate_delivery as module
os.environ.update(PAPERCLIP_API_URL="http://127.0.0.1:3100", PAPERCLIP_TASK_ID="issue",
                  PAPERCLIP_RUN_ID="run", PAPERCLIP_API_KEY="fixture-only")
args=argparse.Namespace(mission_id="mission")
report_args=argparse.Namespace(url="https://github.com/ty000/repo/pull/12", repository="ty000/repo", head="a"*40)
view={"version":3,"delivery":{"integration":{},"authority":{"contract":{"integration":{"mergeMethod":"squash"}}}}}
module.github_integration.report=lambda a:{"state":"open","observedAt":"pinned-source-time"}
module.github_feedback.report=lambda a:{"headCommit":a.head,"observedAt":"pinned-feedback-time"}
source=(409,{"code":"linear_continuity_source_pending"})
publication=(409,{"code":"linear_continuity_publication_pending"})
execute=(200,{"effectPermission":"execute","outcome":"applied"})

def exercise(events, expected_posts, expected_effects, elapsed=0):
    now=[0]; sleeps=[]; requests=[]; effects=[]
    module.time.monotonic=lambda:now[0]
    def sleep(seconds):
        sleeps.append(seconds);now[0]+=seconds
    module.time.sleep=sleep
    with tempfile.TemporaryDirectory() as root:
        directory=pathlib.Path(root)
        class Opener:
            def open(self,request,timeout):
                journal=json.loads((directory/"merge-claim.json").read_text())
                assert json.loads(request.data)==journal
                assert timeout<=30-now[0] and timeout>0
                requests.append((request.data,timeout))
                assert effects==[], "No GitHub effect before execute permission"
                now[0]+=elapsed
                event=events[min(len(requests)-1,len(events)-1)]
                if isinstance(event,Exception):raise event
                status,body=event
                raw=body if isinstance(body,bytes) else json.dumps(body).encode()
                if status!=200:raise urllib.error.HTTPError(request.full_url,status,"fixture",{},io.BytesIO(raw))
                return io.BytesIO(raw)
        module.urllib.request.build_opener=lambda handler:Opener()
        def effect(argv,**kwargs):
            assert json.loads((directory/"merge-permission.json").read_text())["effectPermission"]=="execute"
            assert json.loads(pathlib.Path(argv[-1]).read_text())=={"sha":"a"*40,"merge_method":"squash"}
            effects.append(argv)
            return argparse.Namespace(returncode=0)
        module.subprocess.run=effect
        try:module.merge_once(args,view,report_args,directory)
        except (OSError,ValueError):
            assert expected_effects==0
        assert len(requests)==expected_posts and len(effects)==expected_effects
        assert len(set(body for body,timeout in requests))==1
        assert all(p.stat().st_mode & 0o777==0o600 for p in directory.iterdir())
        try:module.merge_once(args,view,report_args,directory)
        except ValueError:pass
        else:raise AssertionError("Prepared claims must never restart, even after pending exhaustion")
        assert len(requests)==expected_posts and len(effects)==expected_effects
    return sleeps,requests

sleeps,requests=exercise([source,publication,execute],3,1)
assert sleeps==[5,5] and [timeout for body,timeout in requests]==[30,25,20]
sleeps,requests=exercise([source],6,0)
assert sleeps==[5]*5 and requests[-1][1]==5
sleeps,requests=exercise([source],1,0,elapsed=26)
assert sleeps==[]
exercise([source,(409,{"code":"version_conflict"})],2,0)
exercise([source,(200,{"effectPermission":"none","outcome":"replayed"})],2,0)
for refusal in [(409,{"code":"linear_continuity_hold"}), (409,{"code":"integration_review_pending"}),
                (500,{"code":"linear_continuity_source_pending"}), (409,b"malformed"),
                (409,b"x"*2_000_001), OSError("lost response"), TimeoutError("native timeout"),
                (200,{"effectPermission":"none","outcome":"replayed"})]:
    exercise([refusal],1,0)
# Other commands cannot opt into the merge-only waiting contract.
for command in ["n5-inspect","n5-claim-cancellation","n5-claim-publication","n5-observe-integration"]:
    calls=[]
    class Refusal:
        def open(self,request,timeout):
            calls.append(request.data)
            raise urllib.error.HTTPError(request.full_url,409,"fixture",{},io.BytesIO(json.dumps(source[1]).encode()))
    module.urllib.request.build_opener=lambda handler:Refusal()
    try:module.native(args,{"command":command})
    except urllib.error.HTTPError:pass
    else:raise AssertionError("Only the merge claim may wait")
    assert len(calls)==1
print("PASS")
`, resolve("scripts/operations")], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" });
    expect(result.trim()).toBe("PASS");
  });

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
