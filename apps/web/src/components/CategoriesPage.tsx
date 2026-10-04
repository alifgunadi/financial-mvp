import CategoryManager from "./CategoryManager.tsx";

export default function CategoriesPage() {
  return (
    <section id="categories" aria-label="Categories" className="scroll-mt-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold tracking-tight">Categories</h2>
        <p className="mt-1 text-[13px] text-subtle">
          Labels for your transactions
        </p>
      </div>
      <div className="max-w-2xl">
        <CategoryManager />
      </div>
    </section>
  );
}
