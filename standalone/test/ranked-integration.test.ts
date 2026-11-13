import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { encodeClientMessage, decodeServerMessage, createGameWireContext } from "@openfront/shared/ZbinWire";
const base = process.env.FRONT_TEST_BASE ?? "http://localhost:13994/front";
const commit = "2f0252dda9c4330b78ad3012d8570a7e929b071e";
const sockets: WebSocket[] = [];
try {
  async function queue() {
    const jwt = (await (await fetch(`${base}/backend/auth/refresh`, { method: "POST" })).json()).jwt;
    return new Promise<{jwt:string; gameId:string}>((resolve,reject) => {
      const ws = new WebSocket(`${base.replace(/^http/, "ws")}/backend/matchmaking/join?mode=1v1&version=${commit}`); sockets.push(ws);
      const timeout=setTimeout(()=>reject(new Error("matchmaking timed out")),20000);
      ws.on("error",reject);
      ws.on("open",()=>ws.send(JSON.stringify({type:"join",jwt})));
      ws.on("message",data=>{const message=JSON.parse(data.toString());if(message.type==="match-assignment"){clearTimeout(timeout);resolve({jwt,gameId:message.gameId});}});
    });
  }
  const [a,b]=await Promise.all([queue(),queue()]); assert.equal(a.gameId,b.gameId);
  for(let i=0;i<50;i++){ const response=await fetch(`${base}/w0/api/game/${a.gameId}/exists`); if(response.ok) break; await new Promise(r=>setTimeout(r,100)); }
  function join(jwt:string,name:string) {
    return new Promise<WebSocket>((resolve,reject)=>{
      const ws=new WebSocket(`${base.replace(/^http/,"ws")}/w0`);sockets.push(ws);
      const timeout=setTimeout(()=>reject(new Error("game join timed out")),10000);
      ws.on("error",reject);ws.on("open",()=>ws.send(encodeClientMessage({type:"join",gameID:a.gameId,token:jwt,username:name,clanTag:null,turnstileToken:null,gitCommit:commit},undefined)));
      ws.on("message",data=>{const m=decodeServerMessage(new Uint8Array(data as Buffer),undefined); if(m.type==="lobby_info"){clearTimeout(timeout);resolve(ws);} if(m.type==="error")reject(new Error(m.error));});
      ws.on("close",(code,reason)=>{if(code!==1000)reject(new Error(`join closed ${code}: ${reason}`));});
    });
  }
  const host=await join(a.jwt,"RankHost");
  host.removeAllListeners("message");
  const started=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("ranked match did not start")),20000);let ctx:ReturnType<typeof createGameWireContext>|undefined;host.on("message",data=>{const m=decodeServerMessage(new Uint8Array(data as Buffer),ctx);if(m.type==="start")ctx=createGameWireContext(m.gameStartInfo.players);if(m.type==="turn"){clearTimeout(timer);resolve();}});});
  const player=await join(b.jwt,"RankPlayer"); player.removeAllListeners("message"); await started;
  console.log("Two authenticated players were matched by the live worker, joined the same ranked game, and received turns.");
} finally { for(const ws of sockets) ws.terminate(); }
