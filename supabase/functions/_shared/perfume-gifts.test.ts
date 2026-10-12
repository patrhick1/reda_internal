import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { applyPerfumeGiftPolicy, giftPackingInstructions, PERFUME_VENDOR_ID, type ProductResolution } from './perfume-gifts.ts';
const main: ProductResolution = { line: { product_name: 'Opulent Oud', quantity: 2, customer_price: 98000, free: false },
 match: { id: '125334f2-d69a-4431-8356-47b15687a7d5', client_id: PERFUME_VENDOR_ID, client_name: 'Zael NG', product_name: 'Opulent Oud', score: 1 }, candidates: [] };
const gift=(name='Perfume Oil', free=false):ProductResolution=>({line:{product_name:name,quantity:2,customer_price:null,free},match:null,candidates:[]});
const canCreate=(result:ReturnType<typeof applyPerfumeGiftPolicy>,envelope=true)=>envelope && !result.reviewReasons.length
 && result.rows.some(r=>r.match) && result.rows.every(r=>r.match||r.line.free)
 && new Set(result.rows.filter(r=>r.match).map(r=>r.match!.client_id)).size===1;
Deno.test('explicit and implicit bundled gifts keep two perfumes, total and packing quantities',()=>{
 for(const free of [true,false]){
  const input=[main,gift('Perfume Oils',free),gift('Perfume Atomizer',free)];const before=JSON.stringify(input);
  const r=applyPerfumeGiftPolicy(input,'2 Opulent Oud + 2 perfume oils + 2 atomizers');
  assert(canCreate(r));assertEquals(r.rows,[main]);assertEquals(JSON.stringify(input),before);
  assertEquals(r.rows[0].line.customer_price,98000);assertEquals(r.rows[0].line.quantity,2);
  assertEquals(giftPackingInstructions('Call on arrival',r.ignored),'Call on arrival\nIncluded gifts: Perfume Oil ×2, Atomizer ×2.');
 }
});
Deno.test('vendor rename does not disable the rule; unrelated vendor remains unchanged',()=>{
 const renamed={...main,match:{...main.match!,client_name:'Future vendor name'}};
 assert(canCreate(applyPerfumeGiftPolicy([renamed,gift()],'')));
 const other={...main,match:{...main.match!,client_id:'other'}};
 assert(!canCreate(applyPerfumeGiftPolicy([other,gift()],'')));
});
Deno.test('standalone and separately paid accessories are not silently ignored',()=>{
 assertEquals(applyPerfumeGiftPolicy([gift()], '').ignored,[]);
 const paid=gift();paid.line.customer_price=2000;
 const r=applyPerfumeGiftPolicy([main,paid],'');assertEquals(r.ignored,[]);assert(!canCreate(r));
  paid.line.free=true;assert(!canCreate(applyPerfumeGiftPolicy([main,paid],'')));
});
Deno.test('gift matching another vendor cannot contaminate the paid perfume vendor',()=>{
 const foreign={...gift(),match:{...main.match!,client_id:'different'}};
 assert(canCreate(applyPerfumeGiftPolicy([main,foreign],'')));
});
Deno.test('Oil-to-perfume stock corruption is blocked unless source explicitly identifies the gift',()=>{
 const oil={...gift('Oil'),match:{...main.match!,id:'67f486ef-d7c5-4934-8f54-4916abda42df',product_name:'Oud Al Layl Perfume'}};
 const r=applyPerfumeGiftPolicy([main,oil,gift('Atomizer')],'Includes oil');
 assert(!canCreate(r));assertEquals(r.rows[1].match,null);
 const explicit=applyPerfumeGiftPolicy([main,oil,gift('Atomizer')],'2 PERFUME OILS');
 assert(canCreate(explicit));assertEquals(explicit.rows,[main]);
});
Deno.test('wrong Aswad variant and unknown paid products retain review protection',()=>{
 const wrong={...main,line:{...main.line,product_name:'Oud Al Layl Perfume'},match:{...main.match!,product_name:'Oud Al Layl Aswad'}};
 assert(!canCreate(applyPerfumeGiftPolicy([wrong,gift()],'')));
 assert(!canCreate(applyPerfumeGiftPolicy([main,gift(),gift('Unknown paid product')],'')));
});
Deno.test('two recognized perfumes remain independent and missing address still blocks creation',()=>{
 const second={...main,line:{...main.line,product_name:'Khamrah Dukhan',quantity:3},match:{...main.match!,id:'cff5cf56-bf06-4990-b0a3-615d78c8e3e6',product_name:'Khamrah Dukhan'}};
 const r=applyPerfumeGiftPolicy([main,second,gift('Touch Perfume Oil')],'');assert(canCreate(r));
 assertEquals(r.rows.map(r=>r.line.quantity),[2,3]);assert(!canCreate(r,false));
});
Deno.test('bad gift quantities require review and gift notes do not invent quantities',()=>{
 const invalid=gift();invalid.line.quantity=null;
 const r=applyPerfumeGiftPolicy([main,invalid],'');assert(!canCreate(r));assertEquals(r.ignored,[]);
 assertEquals(giftPackingInstructions(null,[]),null);
});
Deno.test('header/body repeated main SKU does not double the stock quantity',()=>{
 const r=applyPerfumeGiftPolicy([main,{...main,line:{...main.line,product_name:'Opulent Oud'}},gift()], '');
 assert(!canCreate(r));assert(r.reviewReasons.some(x=>x.includes('more than once')));
});
Deno.test('other matched free perfume needs its own stock decision',()=>{
 const free={...main,line:{...main.line,product_name:'Pacific Blue Perfume',free:true,customer_price:0},
  match:{...main.match!,id:'d36c6537-3d12-40ac-b14d-aaf46c805932',product_name:'Pacific Blue Perfume'}};
 assert(!canCreate(applyPerfumeGiftPolicy([main,free,gift()],'')));
});
