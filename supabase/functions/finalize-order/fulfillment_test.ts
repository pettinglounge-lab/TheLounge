import { fulfillOrder } from "./fulfillment.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
const assert = (v: unknown, message: string) => { if (!v) throw new Error(message); };

Deno.test("Printify handoff preserves variant/artwork and reconciles uncertain submissions without duplicates", async () => {
  const savedFetch = globalThis.fetch;
  const oldKey = Deno.env.get("PRINTIFY_API_KEY"), oldShop = Deno.env.get("PRINTIFY_SHOP_ID");
  Deno.env.set("PRINTIFY_API_KEY","fixture"); Deno.env.delete("PRINTIFY_SHOP_ID");
  let state = "ready", token = "", posts = 0, completeFails = false, timeout = false, found = true, unavailable = false;
  let orderBody: any;
  const order = { id:"order-1", user_id:"user-1",draft_id:"draft-1",quantity:2,artwork_path:"user-1/art.png",
    product_snapshot:{printify_product_id:"product-1",variant_id:123,blueprint_id:706,print_provider_id:99} };
  const address = {first_name:"Test",last_name:"Buyer",address1:"1 Street",city:"City",country:"US",zip:"12345",email:"test@example.test"};
  const product = { id:"product-1",shop_id:42,blueprint_id:706,print_provider_id:99,
    variants:[{id:123,is_enabled:true,is_available:true}],
    print_areas:[{variant_ids:[123],placeholders:[{position:"front",images:[{id:"stock-image"}]}]}] };
  const admin = {
    async rpc(name: string, args: any) {
      if (name==="claim_order_fulfillment") {
        if(state==="submitted") return {data:{action:"submitted",printify_order_id:"pf-1"}};
        if(state==="dispatched") return {data:{action:"reconcile",shop_id:"42"}};
        if(state==="preparing") return {data:{action:"busy"}};
        state="preparing";token=args.p_token;return {data:{action:"prepare"}};
      }
      if(name==="complete_order_fulfillment") {
        if(completeFails) return {error:true};
        assert(args.p_printify_id==="pf-1","Save exact provider ID"); state="submitted";return {error:null};
      }
      throw new Error(name);
    },
    from(table: string) {
      let update: any;
      const query: any = {
        select() { if(update) { if(update.state) {state="dispatched";} return Promise.resolve({data:[{order_id:"order-1"}]}); } return query; },
        eq(_key: string,_value: unknown) {return query;}, gt() {return query;},
        update(value: any) {update=value;return query;},
        single() {return Promise.resolve({data:table==="orders"?order:{address}});},
        then(resolve: any) {if(update?.lease_until && state==="preparing")state="ready";return Promise.resolve({error:null}).then(resolve);},
      };return query;
    },
    storage:{from(){return {createSignedUrl(path: string){assert(path===order.artwork_path,"Use immutable artwork");return Promise.resolve({data:{signedUrl:"https://storage.example.test/original.png?token=fixture"}});}};}},
  } as unknown as SupabaseClient;
  globalThis.fetch = (async (input: RequestInfo|URL, init?: RequestInit) => {
    const url=String(input);let body: any;
    if(url.endsWith("shops.json")) body=[{id:11},{id:42}];
    else if(url.includes("shops/11/products")) return new Response("",{status:400});
    else if(url.includes("/products/")) body={...product,variants:[{id:123,is_enabled:true,is_available:!unavailable}]};
    else if(url.includes("/catalog/")) body={variants:[{id:123,placeholders:[{position:"front",width:4500,height:5400}]}]};
    else if(url.endsWith("uploads/images.json")) body={id:"image-1",width:1024,height:1536};
    else if(url.includes("orders.json?") && init?.method==="GET") body={data:found?[{id:"pf-1",metadata:{shop_order_label:"order-1"},line_items:[{variant_id:123,quantity:2,print_provider_id:99}]}]:[],next_page_url:null};
    else if(url.endsWith("shops/42/orders.json") && init?.method==="POST") {
      posts++;orderBody=JSON.parse(String(init.body));
      assert(state==="dispatched","Persist dispatch before submission");
      if(timeout)throw new Error("network_timeout");body={id:"pf-1"};
    } else throw new Error("Unexpected URL "+url);
    return new Response(JSON.stringify(body),{headers:{"Content-Type":"application/json"}});
  }) as typeof fetch;
  const fails = async () => {try {await fulfillOrder(admin,"order-1");return false;}catch{return true;}};
  try {
    const results=await Promise.allSettled([fulfillOrder(admin,"order-1"),fulfillOrder(admin,"order-1")]);
    assert(results.some(r=>r.status==="fulfilled") && posts===1,"Concurrent delivery submits once");
    assert(orderBody.line_items[0].variant_id===123 && orderBody.line_items[0].quantity===2,"Exact purchased color/size and quantity");
    assert(!orderBody.line_items[0].product_id,"Never order stock template artwork");
    assert(orderBody.line_items[0].print_areas.front[0].src.includes("original.png"),"Original artwork URL");
    assert(Math.abs(orderBody.line_items[0].print_areas.front[0].scale-0.8)<0.001,"Fit portrait without crop");
    assert(orderBody.address_to.zip===address.zip && orderBody.shipping_method===1,"Saved address and quoted shipping method");
    await fulfillOrder(admin,"order-1"); assert(posts===1,"Completed replay must not repost");
    state="ready";timeout=true;found=false;
    assert(await fails(),"Timeout is retryable");assert(posts===2,"One uncertain dispatch");
    assert(await fails(),"Absent provider result requires review");assert(posts===2,"Never repost uncertain order");
    found=true;await fulfillOrder(admin,"order-1");assert(posts===2,"Recover timed-out order by external ID");
    state="ready";timeout=false;completeFails=true;
    assert(await fails(),"Completion save failure propagates");assert(posts===3,"Provider creation succeeded");
    completeFails=false;await fulfillOrder(admin,"order-1");assert(posts===3,"Recover saved provider result without repost");
    state="ready";unavailable=true;assert(await fails(),"Out-of-stock purchased variant rejected");assert(posts===3,"No substitution of size/color");
  } finally {
    globalThis.fetch=savedFetch;
    for(const [k,v] of [["PRINTIFY_API_KEY",oldKey],["PRINTIFY_SHOP_ID",oldShop]]){if(v===undefined)Deno.env.delete(k!);else Deno.env.set(k!,v);}
  }
});
