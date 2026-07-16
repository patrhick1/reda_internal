import {
  completeProductLines,
  resetProductsForClient,
} from "../mobile/src/screens/deliveries/deliveryFormLogic.ts";

Deno.test("two complete product lines survive payload normalization", () => {
  const lines = completeProductLines([
    { productCatalogId: "normal-tea", quantityOrdered: 1 },
    { productCatalogId: "double-tea", quantityOrdered: 1 },
  ]);
  if (
    JSON.stringify(lines) !==
    JSON.stringify([
      { productCatalogId: "normal-tea", quantityOrdered: 1 },
      { productCatalogId: "double-tea", quantityOrdered: 1 },
    ])
  )
    throw new Error(`unexpected lines: ${JSON.stringify(lines)}`);
});

Deno.test(
  "client switch atomically clears all old-client product state",
  () => {
    const before = {
      clientId: "wendy",
      items: [
        { productCatalogId: "normal-tea", quantityOrdered: 1 },
        { productCatalogId: "double-tea", quantityOrdered: 1 },
      ],
      productCatalogId: "normal-tea",
      quantityOrdered: 1,
      customerName: "Opia Michael",
    };
    const after = resetProductsForClient(before, "another-client");
    if (after.clientId !== "another-client")
      throw new Error("client was not changed");
    if (after.productCatalogId !== null || after.quantityOrdered !== null) {
      throw new Error("legacy primary product state was not cleared");
    }
    if (
      JSON.stringify(after.items) !==
      JSON.stringify([{ productCatalogId: null, quantityOrdered: null }])
    )
      throw new Error(
        `old product lines survived: ${JSON.stringify(after.items)}`,
      );
    if (after.customerName !== before.customerName)
      throw new Error("unrelated form state changed");
  },
);
