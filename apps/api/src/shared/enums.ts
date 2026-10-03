function toDb<T extends string>(t: T): Uppercase<T> {
  return t.toUpperCase() as Uppercase<T>;
}
const toApi = (t: string) => t.toLowerCase();

// Category-type compatibility: BOTH fits everywhere, otherwise the
// category type must equal the transaction type (Prisma enum literals).
function categoryMatchesType(
  categoryType: "INCOME" | "EXPENSE" | "BOTH",
  txType: "INCOME" | "EXPENSE",
): boolean {
  return categoryType === "BOTH" || categoryType === txType;
}

export { categoryMatchesType, toApi, toDb };
