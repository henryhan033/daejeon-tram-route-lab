import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTramGraph,loadTramGraph,rideParameters} from '../lib/tram-graph.js';
import {estimateTramRide,compareRoutesWithTransitous} from '../server.js';

const document=JSON.parse(readFileSync(new URL('../data/tram_edges.json',import.meta.url),'utf8'));
const graph=loadTramGraph();
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('main loop, main/branch and branch/branch use only declared arcs',()=>{
  const examples=[[201,205],[240,201],[212,244],[233,245],[244,245],[245,244]];
  const arcs=new Set(document.routing_arcs.map(a=>`${a.from_id}|${a.to_id}|${a.edge_id}`));
  for(const [from,to] of examples){
    const ride=graph.findRide(from,to);
    assert.equal(ride.nodeIds[0],String(from));assert.equal(ride.nodeIds.at(-1),String(to));
    ride.edgeIds.forEach((edge,i)=>assert.ok(arcs.has(`${ride.nodeIds[i]}|${ride.nodeIds[i+1]}|${edge}`)));
  }
  assert.deepEqual(graph.findRide(240,201).nodeIds,['240','201']);
  assert.deepEqual(graph.findRide(212,244).nodeIds,['212','J_중리','241','242','243','244']);
  assert.deepEqual(graph.findRide(233,245).nodeIds,['233','245']);
  const branch=graph.findRide(244,245).nodeIds;
  assert.ok(branch.includes('J_중리'));assert.ok(branch.includes('233'));
  for(const pair of [['240','241'],['244','245'],['245','201']]){
    assert.equal([...arcs].some(a=>a.startsWith(pair.join('|')+'|')),false);
  }
});

test('junction adds neither a station hop nor dwell; settings and single wait are retained',()=>{
  assert.deepEqual(rideParameters(),{tramSpeed:22.06,headway:10,dwell:20});
  const ride=graph.findRide(212,241,{tramSpeed:18,headway:12,dwell:60});
  assert.equal(ride.path.length,3);assert.equal(ride.hops,1);assert.equal(ride.dwellMin,0);
  close(ride.rideMin,ride.distanceKm/18*60+6);
  const multi=graph.findRide(244,245,{tramSpeed:18,headway:12,dwell:60});
  close(multi.rideMin,multi.distanceKm/18*60+(multi.stationPath.length-2)+6);
  assert.equal(multi.intermediateStops,multi.hops-1);
});

test('minimum time changes with speed and dwell rather than minimizing distance or station count',()=>{
  const ids=[201,202,203,204,205];
  const coords=[[0,0],[.01,.015],[0,.03],[0,.01],[0,.02]];
  const pairs=[[201,202],[202,203],[201,204],[204,205],[205,203]];
  const fake=createTramGraph({nodes:ids.map((id,i)=>({id:String(id),kind:'station',latitude:coords[i][0],longitude:coords[i][1]})),
    edges:pairs.map(([a,b],i)=>({id:`f${i}`,from_id:String(a),to_id:String(b),forward_allowed:true,reverse_allowed:true}))});
  assert.deepEqual(fake.findRide(201,203,{tramSpeed:5,dwell:30}).nodeIds,['201','204','205','203']);
  assert.deepEqual(fake.findRide(201,203,{tramSpeed:100,dwell:30}).nodeIds,['201','202','203']);
  assert.deepEqual(fake.findRide(201,203,{tramSpeed:5,dwell:900}).nodeIds,['201','202','203']);
});

test('all 1,980 ordered station pairs match independent Floyd–Warshall minimum times',()=>{
  const ids=[...graph.nodes.keys()],index=new Map(ids.map((id,i)=>[id,i]));
  for(const params of [{tramSpeed:22.06,headway:10,dwell:20},{tramSpeed:10,headway:18,dwell:60}]){
    const d=ids.map((_,i)=>ids.map((_,j)=>i===j?0:Infinity));
    for(const [from,edges] of graph.adjacency)for(const edge of edges){
      const cost=edge.distanceKm/params.tramSpeed*60+(graph.nodes.get(edge.to).kind==='station'?params.dwell/60:0);
      d[index.get(from)][index.get(edge.to)]=Math.min(d[index.get(from)][index.get(edge.to)],cost);
    }
    for(let k=0;k<ids.length;k++)for(let i=0;i<ids.length;i++)for(let j=0;j<ids.length;j++)d[i][j]=Math.min(d[i][j],d[i][k]+d[k][j]);
    let count=0;
    for(const from of graph.stations())for(const to of graph.stations())if(from.id!==to.id){
      const ride=graph.findRide(from.id,to.id,params);
      assert.ok(ride);close(ride.rideMin,d[index.get(String(from.id))][index.get(String(to.id))]-params.dwell/60+params.headway/2);
      close(ride.rideMin,ride.legs.reduce((s,e)=>s+e.travelMin+e.dwellMin,0)+ride.waitMin);
      count++;
    }
    assert.equal(count,1980);
  }
});

test('reverse direction is never invented and missing/invalid files never form a ring',()=>{
  const oneWay=createTramGraph({nodes:document.nodes.slice(0,2),edges:[{id:'one',from_id:'201',to_id:'202',forward_allowed:true,reverse_allowed:false}]});
  assert.ok(oneWay.findRide(201,202));assert.equal(oneWay.findRide(202,201),null);
  assert.throws(()=>loadTramGraph(new URL('./missing-tram-edges.json',import.meta.url)),{code:'TRAM_GRAPH_MISSING'});
  assert.throws(()=>createTramGraph({...document,routing_arcs:document.routing_arcs.slice(1)}),{code:'TRAM_GRAPH_INVALID'});
  assert.throws(()=>createTramGraph({...document,nodes:document.nodes.map((n,i)=>i===0?{...n,latitude:null}:n)}),{code:'TRAM_GRAPH_INVALID'});
});

test('server estimator uses graph coordinates, time costs and junction topology',()=>{
  const result=estimateTramRide([{id:212,lat:35,lon:129},{id:241,lat:38,lon:130}],{id:212},{id:241},{tramSpeed:22.06,headway:10,dwell:20});
  assert.deepEqual(result.ride.nodeIds,['212','J_중리','241']);
  close(result.rideMin,graph.findRide(212,241).rideMin);
  assert.ok(result.ride.path.every(n=>n.lat>36 && n.lat<37 && n.lon>127 && n.lon<128));
});

test('existing bus/tram comparison consumes the graph with mocked Transitous, no geocoder calls',async()=>{
  const native=globalThis.fetch,requests=[];
  globalThis.fetch=async(url)=>{
    const u=new URL(url);requests.push(u);
    assert.ok(u.pathname.endsWith('/plan'),'Only the unchanged Transitous routing service is called');
    const [lat1,lon1]=u.searchParams.get('fromPlace').split(',').map(Number);
    const [lat2,lon2]=u.searchParams.get('toPlace').split(',').map(Number);
    return Response.json({itineraries:[{duration:900,legs:[{mode:'BUS',duration:900,distance:4000,routeShortName:'106',
      from:{name:'모의 출발',lat:lat1,lon:lon1},to:{name:'모의 도착',lat:lat2,lon:lon2}}]}]});
  };
  try{
    const from=graph.nodes.get('244'),to=graph.nodes.get('245');
    const result=await compareRoutesWithTransitous(from,to,{tramSpeed:20,headway:12,dwell:30});
    const ride=result.tram.ride;
    assert.equal(result.stationCount,45);
    assert.equal(result.assumptions.tramSpeedKmh,20);assert.equal(result.assumptions.headwayMin,12);assert.equal(result.assumptions.dwellSec,30);
    assert.equal(result.assumptions.tramTotalKm,graph.totalDistanceKm);
    for(let i=0;i<ride.edgeIds.length;i++)assert.ok(document.routing_arcs.some(a=>a.edge_id===ride.edgeIds[i]&&String(a.from_id)===ride.nodeIds[i]&&String(a.to_id)===ride.nodeIds[i+1]));
    assert.ok(requests.length>0);
  }finally{globalThis.fetch=native;}
});
