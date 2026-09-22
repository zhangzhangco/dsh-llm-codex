import {streamAppServer} from '../app-server.js';
import {Config} from '../config.js';
const start=Date.now(), times=[];let chars=0,finish;
try {
for await(const c of streamAppServer({command:'codex',config:Config({timeoutMs:180000,cwd:'/tmp'}),prompt:'不要调用工具。请写十二行中文，每行介绍一个月份的自然景色，总字数不少于300字。',model:process.argv[2]||'gpt-5.6-sol',effort:'low',attempt:{produced:false}})){
 if(c.type==='text-delta'){times.push(Date.now()-start);chars+=c.text.length;if(times.length===1)console.log('first text at',times[0],'ms');}
 if(c.type==='finish')finish=Date.now()-start;
}
console.log(JSON.stringify({firstTextMs:times[0],lastTextMs:times.at(-1),finishMs:finish,deltas:times.length,chars}));
if(times.length<2||times[0]>=finish)process.exitCode=1;
}catch(e){console.error(e.code,e.message);process.exitCode=1}
