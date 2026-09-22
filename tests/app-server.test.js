import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {streamAppServer} from '../app-server.js';
import {Config,CodexAdapter} from '../index.js';
const fake=fileURLToPath(new URL('./fake-server.mjs',import.meta.url));
// Node's first argument must be the fixture script; wrapper retains app-server argv.
const wrapper=fileURLToPath(new URL('./fake-codex.sh',import.meta.url));
const args=(mode='ok',extra={})=>({command:wrapper,config:Config({appServerArgs:[mode],timeoutMs:2000}),prompt:'test',model:'gpt-test',effort:'',attempt:{produced:false},...extra});
const collect=async (a)=>{const out=[];for await(const c of streamAppServer(a)) out.push(c);return out};
test('incremental text, final tail only, usage and thread filtering',async()=>{
 const out=[]; const times=[];const start=Date.now();
 for await(const c of streamAppServer(args())) {out.push(c);if(c.type==='text-delta')times.push(Date.now()-start)}
 assert.deepEqual(out.filter(x=>x.type==='text-delta').map(x=>x.text),['你好','世界','！']);
 assert.ok(times[1]-times[0]>=30);assert.equal(out.filter(x=>x.type==='block-start').length,1);
 assert.equal(out.at(-1).type,'finish');assert.equal(out.at(-2).usage.inputTokens,10);
 // Optional counters keep the exec backend's shape: present only when non-zero.
 assert.equal(out.at(-2).usage.cacheReadTokens,2);
 assert.equal('cacheWriteTokens' in out.at(-2).usage,false);
 assert.equal('reasoningTokens' in out.at(-2).usage,false);
});
for(const [mode,code] of [['exit','TRANSPORT'],['partial-exit','TRANSPORT'],['failed','QUOTA'],['approval','INVALID_REQUEST'],['thread-closed','TRANSPORT']])test(mode,async()=>{
 const a=args(mode); await assert.rejects(collect(a),e=>e.code===code);
 if(mode==='partial-exit')assert.equal(a.attempt.produced,true);
});
test('a closed thread fails fast instead of waiting for the timeout',async()=>{
 // The protocol has no top-level fatal error notification, so a thread that dies
 // mid-turn used to burn the whole timeoutMs budget (10 minutes on the live
 // profile). It must be detected from `thread/closed` immediately.
 const a=args('thread-closed');a.config.timeoutMs=60000;
 const started=Date.now();
 await assert.rejects(collect(a),e=>e.code==='TRANSPORT');
 assert.ok(Date.now()-started<5000,'closed thread must not wait for the 60s timeout');
});
test('a retrying error notification is reported, never fatal',async()=>{
 // The real turn emits `error` with willRetry=true while Codex swaps transport;
 // treating it as a failure would abort turns that go on to succeed.
 const out=await collect(args('retry-error'));
 assert.deepEqual(out.filter(x=>x.type==='text-delta').map(x=>x.text),['你好','世界','！']);
 assert.equal(out.at(-1).type,'finish');
});
test('timeout and cleanup',async()=>{const a=args('hang');a.config.timeoutMs=150;await assert.rejects(collect(a),e=>e.code==='TIMEOUT')});
test('cancel and pre-cancel',async()=>{for(const pre of [true,false]){const c=new AbortController();if(pre)c.abort();else setTimeout(()=>c.abort(),100);await assert.rejects(collect(args('hang',{signal:c.signal})),e=>e.code==='ABORTED')}});
test('missing executable',async()=>{await assert.rejects(collect(args('ok',{command:'/nonexistent/codex'})),e=>e.code==='MISSING_CREDENTIAL')});
test('concurrent requests isolated',async()=>{const r=await Promise.all([collect(args()),collect(args())]);assert.deepEqual(r[0],r[1])});
test('consumer stops early',async()=>{for await(const c of streamAppServer(args()))if(c.type==='text-delta')break});
test('adapter handles reasoning-only history and forwards backend',async()=>{
 const adapter=new CodexAdapter(Config({cliBackend:'app-server',appServerArgs:['ok'],timeoutMs:2000}),async()=>'',wrapper);
 const out=[];for await(const c of adapter.stream({model:'gpt-test',messages:[{role:'assistant',content:[{type:'reasoning',text:'hidden'}]},{role:'user',content:[{type:'text',text:'hi'}]}]}))out.push(c);
 assert.equal(out.at(-1).type,'finish');
});

test('partial output prevents API fallback',async()=>{
 const adapter=new CodexAdapter(Config({cliBackend:'app-server',appServerArgs:['partial-exit'],timeoutMs:2000,fallback:{baseURL:'http://127.0.0.1:1'}}),async()=>{throw new Error('fallback must not run')},wrapper);
 await assert.rejects(async()=>{for await(const c of adapter.stream({model:'gpt-test',messages:[{role:'user',content:[{type:'text',text:'hi'}]}]})){}},e=>e.code==='TRANSPORT');
});
