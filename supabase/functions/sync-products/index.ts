// supabase/functions/sync-printify-products/index.ts
//
// ONE Printify sync function:
//
// 1. Gets products from Printify
// 2. Clears stuck "publishing" status
// 3. Adds / updates products in Supabase
// 4. Removes products from Supabase that no longer exist in Printify
//
// Deploy with Verify JWT OFF. Requires the service-role bearer credential.
//
// Required secrets:
// PRINTIFY_API_KEY
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const BASE = "https://api.printify.com";

// Every Printify product is currently made available
// for all three artwork categories.
const CATEGORIES = ["pet", "home", "memory"] as const;


// --------------------------------------------------
// Determine storefront product type
// --------------------------------------------------

function getProductType(title: string) {
  const t = (title || "").toLowerCase();

  if (t.includes("frame")) {
    return "framed-poster";
  }

  if (
    t.includes("greeting") ||
    t.includes("card")
  ) {
    return "greeting-card";
  }

  if (t.includes("canvas")) {
    return "canvas";
  }

  if (t.includes("poster")) {
    return "poster";
  }

  return "other";
}


// --------------------------------------------------
// Main Edge Function
// --------------------------------------------------

export async function handler(req: Request) {

  // Handle browser CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: cors,
    });
  }

  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  const serverKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serverKey) return json({ error: "Sync is not configured." }, 503);
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (token !== serverKey) return json({ error: "Server authentication required." }, 401);

  try {

    // ==================================================
    // ENVIRONMENT VARIABLES
    // ==================================================

    const printifyToken =
      Deno.env.get("PRINTIFY_API_KEY");

    const supabaseUrl =
      Deno.env.get("SUPABASE_URL");

    const serviceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");


    if (!printifyToken) {
      throw new Error(
        "PRINTIFY_API_KEY is not configured"
      );
    }

    if (!supabaseUrl) {
      throw new Error(
        "SUPABASE_URL is not configured"
      );
    }

    if (!serviceRoleKey) {
      throw new Error(
        "SUPABASE_SERVICE_ROLE_KEY is not configured"
      );
    }


    // ==================================================
    // CLIENTS
    // ==================================================

    const printifyHeaders = {
      Authorization:
        `Bearer ${printifyToken}`,
      "Content-Type":
        "application/json",
    };


    const admin = createClient(
      supabaseUrl,
      serviceRoleKey
    );


    // ==================================================
    // 1. GET PRINTIFY SHOPS
    // ==================================================

    console.log(
      "Fetching Printify shops..."
    );


    const shopsRes = await fetch(
      `${BASE}/v1/shops.json`,
      {
        headers: printifyHeaders,
      }
    );


    if (!shopsRes.ok) {

      const errorText =
        await shopsRes.text();

      throw new Error(
        `Printify shops ${shopsRes.status}: ${errorText}`
      );

    }


    const shops =
      await shopsRes.json();


    const shop =
      Array.isArray(shops)
        ? shops[0]
        : shops?.data?.[0];


    if (!shop) {
      throw new Error(
        "No Printify shop found"
      );
    }


    console.log(
      `Using Printify shop: ${shop.title} (${shop.id})`
    );


    // ==================================================
    // 2. GET CURRENT PRINTIFY PRODUCTS
    // ==================================================

    console.log(
      "Fetching Printify products..."
    );


    const productsRes = await fetch(

      `${BASE}/v1/shops/${shop.id}/products.json`,

      {
        headers: printifyHeaders,
      }

    );


    if (!productsRes.ok) {

      const errorText =
        await productsRes.text();

      throw new Error(
        `Printify products ${productsRes.status}: ${errorText}`
      );

    }


    const productJson =
      await productsRes.json();


    const products =
      Array.isArray(productJson)
        ? productJson
        : productJson?.data ?? [];


    // Fetch every page before deciding which catalog records are stale.
    let pageData = productJson;
    let page = 1;
    while (!Array.isArray(pageData) && pageData.next_page_url) {
      const next = await fetch(`${BASE}/v1/shops/${shop.id}/products.json?page=${++page}`, {
        headers: printifyHeaders,
      });
      if (!next.ok) throw new Error("Unable to fetch all product pages; no stale records removed");
      pageData = await next.json();
      if (!Array.isArray(pageData.data)) throw new Error("Invalid product page");
      products.push(...pageData.data);
    }
    console.log(
      `Found ${products.length} Printify products`
    );


    if (!Array.isArray(productJson) && !Array.isArray(productJson?.data)) {
      throw new Error("Invalid product list; no catalog records changed");
    }

    // ==================================================
    // CURRENT PRINTIFY PRODUCT IDS
    // ==================================================

    const currentPrintifyIds =
      products.map(
        (p: any) =>
          String(p.id)
      );


    // ==================================================
    // RESULT COUNTERS
    // ==================================================

    const results: any[] = [];

    let publishingCleared = 0;
    let publishingErrors = 0;

    let syncedRecords = 0;
    let syncErrors = 0;

    let deletedRecords = 0;

    const deletedProductIds: string[] = [];


    // ==================================================
    // 3. PROCESS EVERY CURRENT PRINTIFY PRODUCT
    // ==================================================

    for (const p of products) {

      const productResult: any = {

        title:
          p.title,

        printify_product_id:
          String(p.id),

        publishing:
          null,

        sync:
          [],

      };


      // --------------------------------------------------
      // A. CLEAR PRINTIFY "PUBLISHING" STATUS
      // --------------------------------------------------

      try {

        const publishRes =
          await fetch(

            `${BASE}/v1/shops/${shop.id}/products/${p.id}/publishing_succeeded.json`,

            {

              method:
                "POST",

              headers:
                printifyHeaders,

              body:
                JSON.stringify({

                  external: {

                    id:
                      String(p.id),

                    handle:
                      "https://pettinglounge-lab.github.io/TheLounge/",

                  },

                }),

            }

          );


        if (publishRes.ok) {

          publishingCleared++;

          productResult.publishing = {

            ok:
              true,

            status:
              publishRes.status,

          };

        }

        else {

          const publishError =
            await publishRes.text();

          publishingErrors++;

          productResult.publishing = {

            ok:
              false,

            status:
              publishRes.status,

            error:
              publishError,

          };

        }

      }

      catch (error) {

        publishingErrors++;

        productResult.publishing = {

          ok:
            false,

          error:
            error instanceof Error
              ? error.message
              : String(error),

        };

      }


      // --------------------------------------------------
      // B. PREPARE PRODUCT VARIANTS
      // --------------------------------------------------

      const variants =
        (p.variants || [])

          .filter(

            (v: any) =>

              v.is_enabled === true &&

              v.is_available === true

          )

          .map(

            (v: any) => ({

              id:
                v.id,

              size:
                v.title,

              price:
                (v.price ?? 0) / 100,

            })

          );


      // --------------------------------------------------
      // C. GET PRODUCT IMAGE
      // --------------------------------------------------

      const image =

        p.images?.find(
          (i: any) =>
            i.is_default
        )?.src ||

        p.images?.[0]?.src ||

        null;


      // --------------------------------------------------
      // D. DETERMINE PRODUCT TYPE
      // --------------------------------------------------

      const productType =
        getProductType(
          p.title
        );


      // --------------------------------------------------
      // E. SYNC PET / HOME / MEMORY
      // --------------------------------------------------

      for (
        const category of CATEGORIES
      ) {

        try {

          const { error } =
            await admin

              .from("products")

              .upsert(

                {

                  printify_product_id:
                    String(p.id),

                  title:
                    p.title,

                  category:
                    category,

                  product_type:
                    productType,

                  blueprint_id:
                    p.blueprint_id,

                  print_provider_id:
                    p.print_provider_id,

                  image_url:
                    image,

                  variants:
                    variants,

                  available:
                    variants.length > 0,

                  synced_at:
                    new Date()
                      .toISOString(),

                },

                {

                  onConflict:
                    "printify_product_id,category",

                }

              );


          if (error) {

            throw new Error(
              error.message
            );

          }


          syncedRecords++;


          productResult.sync.push({

            category:
              category,

            ok:
              true,

            productType:
              productType,

            sizes:
              variants.length,

            available:
              variants.length > 0,

          });

        }

        catch (error) {

          syncErrors++;


          productResult.sync.push({

            category:
              category,

            ok:
              false,

            error:
              error instanceof Error
                ? error.message
                : String(error),

          });

        }

      }


      results.push(
        productResult
      );

    }


    // ==================================================
    // 4. FIND PRODUCTS CURRENTLY IN SUPABASE
    // ==================================================

    console.log(
      "Checking for products removed from Printify..."
    );


    const {
      data: existingProducts,
      error: existingError,
    } = await admin

      .from("products")

      .select(
        "printify_product_id"
      );


    if (existingError) {

      throw new Error(
        `Failed to read current Supabase products: ${existingError.message}`
      );

    }


    // --------------------------------------------------
    // Unique Printify IDs currently stored in Supabase
    // --------------------------------------------------

    const existingIds =
      [
        ...new Set(

          (existingProducts || [])

            .map(
              (row: any) =>
                String(
                  row.printify_product_id
                )
            )

            .filter(
              (id: string) =>
                id &&
                id !== "null" &&
                id !== "undefined"
            )

        ),
      ];


    // ==================================================
    // 5. FIND PRODUCTS DELETED FROM PRINTIFY
    // ==================================================

    const staleProductIds =
      existingIds.filter(

        (id: string) =>
          !currentPrintifyIds.includes(
            id
          )

      );


    console.log(
      `Found ${staleProductIds.length} deleted Printify products`
    );


    // ==================================================
    // 6. DELETE STALE PRODUCTS FROM SUPABASE
    // ==================================================

    if (
      staleProductIds.length > 0
    ) {

      const {
        data: deletedRows,
        error: deleteError,
      } = await admin

        .from("products")

        .delete()

        .in(
          "printify_product_id",
          staleProductIds
        )

        .select(
          "printify_product_id, category"
        );


      if (deleteError) {

        throw new Error(
          `Failed to delete stale products: ${deleteError.message}`
        );

      }


      deletedRecords =
        deletedRows?.length ?? 0;


      deletedProductIds.push(
        ...staleProductIds
      );


      console.log(
        `Deleted ${deletedRecords} Supabase records`
      );

    }


    // ==================================================
    // 7. RETURN SYNC REPORT
    // ==================================================

    return json({

      success:
        syncErrors === 0,

      shop: {

        id:
          shop.id,

        title:
          shop.title,

      },


      printify: {

        products_found:
          products.length,

        current_product_ids:
          currentPrintifyIds,

      },


      publishing: {

        cleared:
          publishingCleared,

        errors:
          publishingErrors,

      },


      database: {

        synced_records:
          syncedRecords,

        sync_errors:
          syncErrors,

        deleted_printify_products:
          deletedProductIds.length,

        deleted_database_records:
          deletedRecords,

        deleted_product_ids:
          deletedProductIds,

      },


      categories:
        CATEGORIES,


      products:
        results,

    });


  }

  catch (error) {

    console.error(
      "sync-printify-products error:",
      error
    );


    return json(

      {

        success:
          false,

        error:
          error instanceof Error
            ? error.message
            : String(error),

      },

      500

    );

  }

}

if (import.meta.main) Deno.serve(handler);

// --------------------------------------------------
// JSON RESPONSE HELPER
// --------------------------------------------------

function json(
  body: unknown,
  status = 200
) {

  return new Response(

    JSON.stringify(
      body
    ),

    {

      status,

      headers: {

        ...cors,

        "Content-Type":
          "application/json",

      },

    }

  );

}
