import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { performance } from 'node:perf_hooks';
import { utf8Bytes, reportText, splitShareReport } from './share-report.ts';
const require=createRequire(import.meta.url);
const ts=require('typescript');
const cache=new Map();
function load(name){
 if(cache.has(name))return cache.get(name);
 const exports={};cache.set(name,exports);
 const file=new URL('../'+name.slice(2)+'.ts',import.meta.url);
 const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 runInNewContext(code,{exports,require:load});return exports;
}
const {buildClientShareReport,buildClientShareMessage}=load('@/lib/reconcile');
const header='Reda Logistics — Test vendor\nDelivered Update\n28 September 2026';
const sample=(count)=>({header,blocks:Array.from({length:count},(_,i)=>'Name: Customer '+i+'\nProducts:\nMint Spray ×2\nToothpaste ×4\nTo Remit: ₦43,000\nNote: Reference '+i+' —'),footer:'Total\nTo Remit: ₦99,000\n\nThank you 🥂'});
function checked(report,limit=3500){const parts=splitShareReport(report,limit);for(const p of parts){assert.equal(p.bytes,Buffer.byteLength(p.text,'utf8'));assert(p.bytes<=limit);assert(p.text.length>0);}return parts;}
function body(part,report){return part.text.slice((report.header+'\n'+part.text.split('\n').find(x=>/^Part \d+ of \d+$/.test(x))+'\n\n').length);}

test('UTF-8 matches the independent encoder for money, accents, emoji and malformed surrogates',()=>{
 for(const s of ['', 'abc\r\n', '₦43,000 — ×2', 'é中文', '👩🏽‍💻🥂', '\ud800a\udc00', '😀'.repeat(1000)]) assert.equal(utf8Bytes(s),Buffer.byteLength(s,'utf8'));
});
test('short report stays byte-for-byte identical; exactly 3500 bytes remains one message',()=>{
 const r={header:'H',blocks:['x'.repeat(3494)],footer:'F'};
 assert.equal(Buffer.byteLength(reportText(r)),3500);assert.deepEqual(checked(r),[{text:reportText(r),bytes:3500}]);
 assert(checked({...r,blocks:[r.blocks[0]+'x']}).length>1);
});
test('complete customer blocks stay intact, ordered, and totals occur only in the last part',()=>{
 const r=sample(70),parts=checked(r);assert(parts.length>1);
 assert.equal(parts.map(p=>body(p,r)).join('\n\n'),[...r.blocks,r.footer].join('\n\n'));
 for(const block of r.blocks)assert.equal(parts.filter(p=>p.text.includes(block)).length,1);
 assert(parts.at(-1).text.endsWith(r.footer));assert.equal(parts.filter(p=>p.text.includes('Total\n')).length,1);
 parts.forEach((p,i)=>assert(p.text.startsWith(header+'\nPart '+(i+1)+' of '+parts.length+'\n\n')));
});
test('all shared text counts toward the budget, including multi-byte headings and totals',()=>{
 const r={...sample(10),header:'₦'.repeat(80)+'\nDate',footer:'Total\n'+('銭🥂'.repeat(90))};checked(r,1200);
});
test('long notes, internal paragraphs and unbroken Unicode text are preserved with continuation labels',()=>{
 for(const long of ['Note: '+('中文 👩🏽‍💻 ₦ —\n\n'.repeat(1300)), '🥂'.repeat(6000), 'line one\n'+'x'.repeat(10000)+'\n  trailing spaces  ']){
  const r={header,blocks:[long],footer:'END_TOTALS'};const parts=checked(r);
  const content=parts.slice(0,-1).map(p=>body(p,r).replace(/^\(continued\)\n/,'')).join('');
  assert.equal(content,long);assert(parts.slice(1,-1).every(p=>body(p,r).startsWith('(continued)\n')));
  assert.equal(body(parts.at(-1),r),'END_TOTALS');
 }
});
test('large totals split without omission when a report has many different products',()=>{
 const r={header,blocks:['Name: Test'],footer:'Total\n'+Array.from({length:800},(_,i)=>'Product '+i+': 1').join('\n')};
 const parts=checked(r);assert.equal(body(parts[0],r),'Name: Test');
 assert.equal(parts.slice(1).map(p=>body(p,r).replace(/^\(continued\)\n/,'')).join(''),r.footer);
});
test('part numbering remains within budget across 9, 99 and 999 parts',()=>{
 for(const count of [9,99,999]){const r={header:'Header',blocks:Array.from({length:count},(_,i)=>'Order '+i+' '+('x'.repeat(65))),footer:'Totals'};const parts=checked(r,120);assert(parts.length>=count);}
});
test('paragraphs inside an order do not create extra orders',()=>{
 const r={...sample(30),blocks:['Name: First\nNote: paragraph one\n\nparagraph two',...sample(30).blocks]};
 assert.equal(checked(r).filter(p=>p.text.includes(r.blocks[0])).length,1);
});
test('oversized headings and invalid budgets fail visibly instead of truncating',()=>{
 assert.throws(()=>splitShareReport({...sample(2),header:'x'.repeat(3490)}),/heading/);
 for(const limit of [0,-1,NaN,3.5])assert.throws(()=>splitShareReport(sample(1),limit),/Invalid/);
});
test('real report formatter preserves custom amounts, phones, negative remits and final account totals',()=>{
 const input={clientName:'Test vendor',rangeLabel:'28 September 2026',format:'paidFeeAndRemit',showPhone:true,rows:[{customerName:'Test customer',customerPhone:'08000000000',products:[{name:'Mint Spray',qty:2},{name:'Toothpaste',qty:4}],paid:50000,redaFee:7000,remit:43000,paymentMethod:'cash',note:'—',clientRep:'REF'}]};
 const r=buildClientShareReport(input);const text=buildClientShareMessage(input);
 assert.equal(reportText(r),text);assert(text.includes('Phone: 08000000000\nProducts:\nMint Spray ×2\nToothpaste ×4\nCustomer paid: ₦50,000\nDelivery fee: ₦7,000\nTo remit: ₦43,000\nNote: REF —'));
 assert(text.endsWith('Total\nMint Spray: 2\nToothpaste: 4\nTo Remit: ₦43,000\n\nThank you for choosing REDA 🥂'));
 for(const format of ['default','paidAndFee','paidFeeAndRemit']){
  const rr=buildClientShareReport({...input,format,rows:Array.from({length:50},()=>input.rows[0]),account:{balanceBeforePeriod:-2500,periodActivity:2150000,payoutsInPeriod:100,paymentsInPeriod:50,currentBalance:2147450}});
  const parts=checked(rr);assert(parts.at(-1).text.includes('Previous balance: ₦-2,500'));assert(parts.at(-1).text.includes('Reda remits client: ₦2,147,450'));
 }
 const negative=buildClientShareMessage({...input,rows:[{...input.rows[0],remit:-2500}]});assert(negative.includes('To remit: ₦-2,500'));
});
test('empty reports and pickup/replacement blocks keep existing wording',()=>{
 const empty=buildClientShareReport({clientName:'Test',rangeLabel:'Date',rows:[]});assert(reportText(empty).includes('(no deliveries in this range)'));checked(empty);
 const mixed=buildClientShareReport({clientName:'Test',rangeLabel:'Date',rows:[{orderType:'waybill',customerName:'Pickup',note:'Pickup ₦500',remit:-500,products:[]},{orderType:'replacement',customerName:'Test',paid:0,remit:-2000,note:'Replacement note',products:[]}]});
 assert(reportText(mixed).includes('Pickup ₦500'));assert(reportText(mixed).includes('Replacement: Test\nCustomer paid: ₦0\nClient owes Reda: ₦2,000'));
});
test('large reports scale without repeated full-string encoding per order',()=>{
 const r=sample(10000);const start=performance.now();const parts=checked(r);const elapsed=performance.now()-start;
 assert(parts.length>100);assert(elapsed<5000,'10,000-order split should finish within 5 seconds');console.log('10,000-order split:',Math.round(elapsed),'ms;',parts.length,'parts');
});
