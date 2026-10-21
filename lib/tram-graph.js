import {readFileSync} from 'node:fs';

function graphError(message,code='TRAM_GRAPH_INVALID') {
  return Object.assign(new Error(message),{code,status:503});
}
const number=(value,fallback)=>value===null||value===undefined||String(value).trim()===''?fallback:Number.isFinite(Number(value))?Number(value):fallback;
export function rideParameters(params={}) {
  return {tramSpeed:Math.max(5,number(params.tramSpeed,22.06)),headway:Math.max(1,number(params.headway,10)),dwell:Math.max(0,number(params.dwell,20))};
}
export function straightDistanceKm(a,b) {
  const r=Math.PI/180,lat1=a.lat*r,lat2=b.lat*r,dl=(b.lon-a.lon)*r;
  const h=Math.sin((lat2-lat1)/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dl/2)**2;
  return 2*6371*Math.asin(Math.sqrt(Math.max(0,Math.min(1,h))));
}
export function createTramGraph(document) {
  if(!Array.isArray(document?.nodes)||!Array.isArray(document?.edges))throw graphError('tram_edges.json에 nodes·edges가 필요합니다.');
  const nodes=new Map(),adjacency=new Map(),edgeIds=new Set(),arcs=new Set();
  for(const n of document.nodes){
    const id=String(n.id),lat=n.latitude,lon=n.longitude;
    if(nodes.has(id)||!['station','junction'].includes(n.kind)||typeof lat!=='number'||typeof lon!=='number'||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)
      throw graphError(`트램 노드 ID·좌표가 유효하지 않습니다: ${id}`);
    nodes.set(id,{id:n.kind==='station'?Number(id):id,name:n.name,kind:n.kind,lat,lon});adjacency.set(id,[]);
  }
  let totalDistanceKm=0;
  for(const edge of document.edges){
    const from=String(edge.from_id),to=String(edge.to_id);
    if(!edge.id||edgeIds.has(edge.id)||!nodes.has(from)||!nodes.has(to)||from===to||typeof edge.forward_allowed!=='boolean'||typeof edge.reverse_allowed!=='boolean')
      throw graphError(`트램 간선 ID·연결·방향이 유효하지 않습니다: ${edge.id}`);
    edgeIds.add(edge.id);
    const distanceKm=straightDistanceKm(nodes.get(from),nodes.get(to));
    totalDistanceKm+=distanceKm;
    for(const [a,b,allowed] of [[from,to,edge.forward_allowed],[to,from,edge.reverse_allowed]]){
      if(!allowed)continue;
      const key=`${edge.id}|${a}|${b}`;
      arcs.add(key);adjacency.get(a).push({edgeId:edge.id,from:a,to:b,section:edge.section,distanceKm});
    }
  }
  if(document.routing_arcs){
    const declared=new Set(document.routing_arcs.map(a=>`${a.edge_id}|${a.from_id}|${a.to_id}`));
    if(declared.size!==document.routing_arcs.length||declared.size!==arcs.size||[...declared].some(key=>!arcs.has(key)))
      throw graphError('tram_edges.json의 routing_arcs와 간선 방향 설정이 다릅니다.');
  }
  function findRide(fromId,toId,params={}){
    const start=String(fromId),end=String(toId),settings=rideParameters(params);
    if(nodes.get(start)?.kind!=='station'||nodes.get(end)?.kind!=='station')return null;
    const costs=new Map([[start,0]]),previous=new Map(),pending=new Set(nodes.keys());
    while(pending.size){
      let current=null,best=Infinity;
      for(const id of pending)if((costs.get(id)??Infinity)<best){current=id;best=costs.get(id);}
      if(current===null)break;
      pending.delete(current);if(current===end)break;
      for(const edge of adjacency.get(current)){
        if(!pending.has(edge.to))continue;
        const travelMin=edge.distanceKm/settings.tramSpeed*60;
        const dwellMin=nodes.get(edge.to).kind==='station'&&edge.to!==end?settings.dwell/60:0;
        const cost=best+travelMin+dwellMin;
        if(cost<(costs.get(edge.to)??Infinity)){costs.set(edge.to,cost);previous.set(edge.to,edge);}
      }
    }
    if(!costs.has(end))return null;
    const ids=[end],legs=[];
    while(ids[0]!==start){const edge=previous.get(ids[0]);if(!edge)return null;legs.unshift(edge);ids.unshift(edge.from);}
    const path=ids.map(id=>({...nodes.get(id)})),stationPath=path.filter(n=>n.kind==='station');
    const distanceKm=legs.reduce((sum,e)=>sum+e.distanceKm,0),hops=stationPath.length-1;
    const intermediateStops=Math.max(0,stationPath.length-2),waitMin=hops>0?settings.headway/2:0;
    return {distanceKm,hops,path,stationPath,nodeIds:ids,edgeIds:legs.map(e=>e.edgeId),
      legs:legs.map(e=>({...e,travelMin:e.distanceKm/settings.tramSpeed*60,dwellMin:nodes.get(e.to).kind==='station'&&e.to!==end?settings.dwell/60:0})),
      intermediateStops,travelMin:distanceKm/settings.tramSpeed*60,dwellMin:intermediateStops*settings.dwell/60,
      waitMin,rideMin:costs.get(end)+waitMin,...settings,
      source:'data/tram_edges.json',geometryType:'schematic_straight_connections',
      simulationAssumption:'지선 분기·합류 이동은 JSON에서 허용한 방향을 따르는 시뮬레이션이며 실제 운행계통·환승을 보장하지 않음.'};
  }
  return {nodes,adjacency,totalDistanceKm,findRide,stations:()=>[...nodes.values()].filter(n=>n.kind==='station').map(n=>({...n}))};
}
export function loadTramGraph(file=new URL('../data/tram_edges.json',import.meta.url)) {
  let text;
  try{text=readFileSync(file,'utf8');}catch(e){throw graphError(`트램 연결 파일을 읽을 수 없습니다. 임의 순환선을 생성하지 않습니다: ${String(file)}`,'TRAM_GRAPH_MISSING');}
  let document;
  try{document=JSON.parse(text);}catch{throw graphError('tram_edges.json의 JSON 형식이 올바르지 않습니다.');}
  const graph=createTramGraph(document);
  const stationIds=graph.stations().map(s=>s.id);
  if(stationIds.length!==45||Array.from({length:45},(_,i)=>201+i).some(id=>!stationIds.includes(id)))
    throw graphError('tram_edges.json에 201~245번 정거장 45개가 필요합니다.');
  return graph;
}
