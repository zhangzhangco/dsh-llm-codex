import { createInterface } from 'node:readline';
const mode = process.argv[3];
const emit = (method, params) => console.log(JSON.stringify({method,params}));
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
 if(m.method==='thread/start') {
  if(m.params.sandbox!=='read-only'||m.params.approvalPolicy!=='never') process.exit(3);
  console.log(JSON.stringify({id:m.id,result:{thread:{id:'t'}}}));
 }
 if(m.method==='turn/start') {
  console.log(JSON.stringify({id:m.id,result:{turn:{id:'r'}}}));
  if(mode==='hang') continue;
  if(mode==='exit') process.exit(1);
  if(mode==='approval') { console.log(JSON.stringify({id:100,method:'item/commandExecution/requestApproval',params:{}})); continue; }
  // A thread the server closes without ever completing the turn (observed
  // protocol shape: `thread/closed` carries only threadId).
  if(mode==='thread-closed') { emit('thread/closed',{threadId:'t'}); continue; }
  // The transport-retry report a real turn emits before it succeeds. It must
  // never be mistaken for a failure: the verdict is `turn/completed`. The error
  // info uses the struct variant shape a real quota-blocked turn reported.
  if(mode==='retry-error') emit('error',{threadId:'t',turnId:'r',willRetry:true,error:{message:'Falling back from WebSockets to HTTPS transport',codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:null}}}});
  const p={threadId:'t',turnId:'r',itemId:'a'};
  emit('item/agentMessage/delta',{...p,threadId:'wrong',delta:'BAD'});
  emit('item/agentMessage/delta',{...p,delta:'你好'});
  if(mode==='partial-exit') {setTimeout(()=>process.exit(1),30);continue;}
  setTimeout(()=>{
   emit('item/agentMessage/delta',{...p,delta:'世界'});
   emit('item/completed',{...p,item:{id:'a',type:'agentMessage',text:'你好世界！'}});
   emit('thread/tokenUsage/updated',{...p,tokenUsage:{last:{inputTokens:10,outputTokens:4,cachedInputTokens:2,reasoningOutputTokens:0}}});
   emit('turn/completed',{threadId:'t',turn:{id:'r',status:mode==='failed'?'failed':'completed',error:{message:'limit',codexErrorInfo:'usageLimitExceeded'}}});
  },70);
 }
}
