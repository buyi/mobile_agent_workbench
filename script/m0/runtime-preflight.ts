/** Root Supervisor-only diagnosis. Never invokes startPrepared or a model. */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { OpenCodeCli, restrictedConfigBinding, type RestrictedConfig } from "../../packages/runtime/src"
import { buildStartInput } from "../../packages/delivery/src/integration/worker-dispatch"
import type { ControlLoopSpec } from "./control-loop"
if (process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw new Error("root required")
const args = new Map<string,string>();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1])
const spec:ControlLoopSpec=JSON.parse(readFileSync(args.get("--spec")!,"utf8"));const scopeId=args.get("--scope")!,generation=Number(args.get("--generation"))
const goal=JSON.parse(readFileSync(spec.goal.path,"utf8"));const budget=JSON.parse(readFileSync(join(spec.controlDirectory,"execution-budget.json"),"utf8"))
const restricted:RestrictedConfig={readPaths:["sumEvenThrough.ts"],editPaths:["sumEvenThrough.ts"],agent:{name:"m0-editor",steps:3},model:{provider:"openai",model:"gpt-6.1-sol",variant:"medium"},catalog:spec.catalog,
 oauthAccess:async()=>({access:"NONSECRET_PREFLIGHT_ONLY_NO_MODEL_REQUEST",expiresAt:Date.now()+3600000}),
 isolation:{identityRuntime:spec.bun,runtimeDirectory:spec.runtimeDirectory,childIdentity:{uid:420,gid:420},launcher:{argvPrefix:["/usr/bin/python3",spec.wrapper.path,"--uid","420","--gid","420","--"],wrapperPath:spec.wrapper.path,wrapperDigest:spec.wrapper.digest},admission:{scopeId,generation},denyRead:[spec.controlDirectory,"/private/var/loopit/signer"],proxyPort:7897}}
const adapter=new OpenCodeCli({executable:spec.executable.path,executableDigest:spec.executable.digest,version:spec.executable.version,stateDirectory:join(spec.controlDirectory,"runtime-preflight"),restricted})
const handle={attemptId:`diagnostic-${scopeId}`,operationId:`diagnostic-${scopeId}`};const input=buildStartInput(goal,{eventId:handle.operationId,runId:spec.runId,taskId:goal.taskId,goalRevision:goal.goalRevision,handle},{workingDirectory:spec.workspace,runtime:{name:"opencode",version:spec.executable.version,sourceDigest:spec.executable.digest},model:{provider:"openai",model:"gpt-6.1-sol"},wallMinutes:60,restrictedBinding:restrictedConfigBinding(restricted),executionBudget:budget},new Date().toISOString())
let result:Record<string,unknown>={scopeId,generation,modelRequests:0,credentialsVerified:false}
try{await adapter.prepareStart(input,handle.operationId);result={...result,status:"prepared_not_started"}}
catch(error){result={...result,status:"blocked",error:error instanceof Error?{name:error.name,message:error.message}:"preparation failed"};process.exitCode=2}
writeFileSync(join(spec.controlDirectory,"reports",`runtime-preflight-${scopeId}.json`),JSON.stringify(result,null,2)+"\n",{flag:"wx",mode:0o600});console.log(JSON.stringify(result))
