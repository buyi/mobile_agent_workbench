import { test, expect } from "bun:test"
import { preparationStopAuthority, openCodeProjectMarker, repairRunAuthority } from "../m0/control-loop-authority"
const fixture = () => ({ scopeId: "current", generation: 9, phase: "running", priorStopProofs: {
  scopeId: "previous", generation: 8,
  ...Object.fromEntries([["worker",420,"loopit-worker"],["signer",421,"loopit-signer"]].map(([key,uid,account])=>[key,{
    schemaVersion:"worker-stop-proof/1",scopeId:"previous",generation:8,serviceAccount:account,observedUid:uid,observedGid:420,workerUid:420,
    noLiveWorkerProcesses:true,userDomainAbsent:true,externalActionsVerified:false,
    observations:Array.from({length:3},()=>({userDomainPresent:false,processes:[]}))
  }]))
}}) as any
test("preparation recovery needs both accounts' previous local stop observations",()=>{
  const valid=fixture();expect(preparationStopAuthority(valid,"current",9)).toEqual(valid.priorStopProofs)
  for(const change of [
    (v:any)=>v.phase="stopped",(v:any)=>v.scopeId="other",(v:any)=>v.generation=10,
    (v:any)=>v.priorStopProofs.generation=9,(v:any)=>delete v.priorStopProofs.signer,
    (v:any)=>v.priorStopProofs.worker.scopeId="other",(v:any)=>v.priorStopProofs.signer.observedUid=420,
    (v:any)=>v.priorStopProofs.worker.userDomainAbsent=false,(v:any)=>v.priorStopProofs.signer.noLiveWorkerProcesses=false,
    (v:any)=>v.priorStopProofs.worker.observations.pop(),
    (v:any)=>v.priorStopProofs.signer.observations[2].userDomainPresent=true,
    (v:any)=>v.priorStopProofs.worker.observations[0].processes.push({state:"S"}),
  ]) {const changed=fixture();change(changed);expect(()=>preparationStopAuthority(changed,"current",9)).toThrow()}
})
test("a repair creates a new Run with the same absolute budget and preserves terminal failure",()=>{
  const now=Date.now(), budget={deadlineAt:new Date(now+300000).toISOString(),repairIndex:1,maxRepairs:3 as const}
  const authorization={schemaVersion:"m0-control-repair/1",priorRunId:"old",nextRunId:"new",budgetBefore:{...budget,repairIndex:0},budgetAfter:budget}
  const prior={status:"failed",binding:{runId:"old",goalDigest:"digest",goalRevision:1,taskId:"task",projectId:"project"}}
  const task={taskId:"task",projectId:"project",currentRevision:1,runs:{old:{status:"failed"}},revisions:{1:{status:"active",runIds:["old"],goalDigest:"digest"}}}
  const fixture=()=>structuredClone({authorization,prior,task,budget}) as any
  expect(repairRunAuthority(authorization,prior,task,"new",budget,now)).toBe("old")
  for(const change of [
    (v:any)=>v.authorization.nextRunId="other",(v:any)=>v.authorization.budgetBefore.deadlineAt=new Date(now+600000).toISOString(),
    (v:any)=>v.authorization.budgetBefore.repairIndex=1,(v:any)=>v.task.runs.old.status="running",
    (v:any)=>v.task.runs.new={status:"failed"},(v:any)=>v.task.revisions[1].status="succeeded",
    (v:any)=>v.prior.status="passed",(v:any)=>v.prior.binding.goalDigest="changed",(v:any)=>v.prior.binding.goalRevision=2,
    (v:any)=>v.budget.deadlineAt=new Date(now-1).toISOString(),(v:any)=>v.budget.repairIndex=0,
    (v:any)=>v.task.revisions[1].runIds.push("different"),
  ]) {const f=fixture();change(f);expect(()=>repairRunAuthority(f.authorization,f.prior,f.task,"new",f.budget,now)).toThrow()}
})
test("native project marker accepts only exact pinned root commit bytes",()=>{
  const commit="0dad15bb36944a36fed40c48c67a1a08d4b92296"
  expect(openCodeProjectMarker(Buffer.from(commit),commit)).toBe("sha256:80f0f265baa27fb7b6f7393dff1fade7815780d8b4c6ffe8966f2fff3c63ba78")
  for(const value of [commit+"\n","other",commit.replace(/^0/,"1"),""])
    expect(()=>openCodeProjectMarker(Buffer.from(value),commit)).toThrow()
})
