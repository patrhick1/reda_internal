// Execute the actual screen component and its RefreshControl callback, with
// framework/service boundaries stubbed. Native gesture recognition is manual.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../mobile/package.json', import.meta.url));
const ts = require('typescript');
const root = process.env.STOCK_SOURCE_ROOT
  ? pathToFileURL(path.resolve(process.env.STOCK_SOURCE_ROOT) + path.sep)
  : new URL('../../mobile/', import.meta.url);

function render(screen, {coverageFetching=false} = {}) {
  const elements = [], calls = [];
  const result = name => ({data:[],loading:false,fetching:name==='coverage' && coverageFetching,error:null,reload:async()=>{calls.push(name);},refetchIfStale:()=>{}});
  const jsx = (type, props) => { const element = {type,props}; elements.push(element); return element; };
  const react = {memo:f=>f,useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useMemo:f=>f(),useCallback:f=>f,useEffect:()=>{}};
  const emptyTheme = new Proxy({}, {get:()=>''});
  const mocks = {
    react,
    'react/jsx-runtime':{jsx,jsxs:jsx},
    'react-native':new Proxy({}, {get:(_,name)=>name}),
    'expo-router':{useRouter:()=>({})},
    'react-native-safe-area-context':{useSafeAreaInsets:()=>({bottom:0})},
    '@/hooks/useAuth':{useCurrentUser:()=>({userId:'agent-a',role:screen.includes('warehouse')?'warehouse':'agent'})},
    '@/hooks/useAsync':{useAsync:()=>result('async')},
    '@/hooks/useReloadOnFocus':{useReloadOnFocus:()=>{}},
    '@/hooks/useAgentUnreadMessages':{useAgentUnread:()=>({byDelivery:{},total:0})},
    '@/hooks/queries':{
      useDeliveriesList:()=>result('deliveries'),useAgentPostponed:()=>result('postponed'),
      useAgentOverdueReplacements:()=>result('overdue'),useStockCoverage:()=>result('coverage'),useRestockSignal:()=>result('restock'),
    },
    '@/lib/theme':{colors:emptyTheme,fonts:emptyTheme,statusBucket:()=> 'active'},
    '@/lib/financial-refresh':{useFinancialRevision:()=>0},
    '@/lib/stock-helpers':{getHolderStats:()=>({products:0,units:0,negative:0}),isNegative:()=>false},
    '@/lib/restock-signal':{coverByProduct:()=>new Map(),withOutOfStock:rows=>rows},
    '@/lib/stock-signal':{COMMITTED_STATUSES:new Set(),SIGNAL_META:{}},
    '@/components/ui':new Proxy({}, {get:(_,name)=>name}),
  };
  const fallback = new Proxy({}, {get:()=>()=>false});
  const source = ts.transpileModule(readFileSync(new URL(screen,root),'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
  }).outputText;
  const exports = {};
  vm.runInNewContext(source,{exports,Date,Map,Set,require:name=>mocks[name]??fallback});
  exports.default();
  const refresh = elements.filter(e=>e.type==='RefreshControl');
  assert.equal(refresh.length,1);
  return {refresh:refresh[0].props,calls};
}
for (const screen of ['app/(agent)/today/index.tsx','app/(warehouse)/(home)/index.tsx']) {
  test(`${screen}: manual refresh requests coverage even with a fresh cache`, async () => {
    const h = render(screen);
    await h.refresh.onRefresh();
    assert.equal(h.calls.filter(c=>c==='coverage').length,1);
    assert(h.calls.includes(screen.includes('warehouse')?'async':'deliveries'),'Existing list refresh remains');
  });
  test(`${screen}: refresh indicator includes coverage fetching`, () => {
    assert.equal(render(screen,{coverageFetching:true}).refresh.refreshing,true);
    assert.equal(render(screen).refresh.refreshing,false);
  });
}
