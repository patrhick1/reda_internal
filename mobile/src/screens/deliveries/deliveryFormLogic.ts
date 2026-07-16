export type ProductLineDraft = {
  productCatalogId: string | null;
  quantityOrdered: number | null;
};

export function completeProductLines(items: ProductLineDraft[]): {
  productCatalogId: string;
  quantityOrdered: number;
}[] {
  return items
    .filter(
      (line): line is { productCatalogId: string; quantityOrdered: number } =>
        !!line.productCatalogId && line.quantityOrdered != null && line.quantityOrdered > 0,
    )
    .map((line) => ({
      productCatalogId: line.productCatalogId,
      quantityOrdered: line.quantityOrdered,
    }));
}

/** Change client and clear all product state in one update. This prevents a
 * render or submit containing the new client with the old client's products. */
export function resetProductsForClient<
  T extends {
    clientId: string | null;
    items: ProductLineDraft[];
    productCatalogId: string | null;
    quantityOrdered: number | null;
  },
>(state: T, clientId: string): T {
  return {
    ...state,
    clientId,
    items: [{ productCatalogId: null, quantityOrdered: null }],
    productCatalogId: null,
    quantityOrdered: null,
  };
}
