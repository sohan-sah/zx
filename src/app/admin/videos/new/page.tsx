import { requireAdmin } from '@/lib/auth/require-admin';
import { createServiceRoleClient } from '@/lib/supabase/service-role';
import { createVideoAction } from '@/lib/actions/admin-videos';

export default async function NewVideoPage() {
  await requireAdmin();

  const svc = createServiceRoleClient();
  const { data: categories } = await svc.from('categories').select('id, name').order('name');

  return (
    <main>
      <h1>Crear video</h1>
      <form action={createVideoAction}>
        <label>
          Título
          <input type="text" name="title" maxLength={200} required />
        </label>
        <label>
          Descripción
          <textarea name="description" maxLength={5000} rows={6} />
        </label>
        <label>
          Categoría
          <select name="categoryId" defaultValue="">
            <option value="">Sin categoría</option>
            {categories?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Crear</button>
      </form>
      {(!categories || categories.length === 0) && (
        <p className="video-card__meta">
          No hay categorías todavía. La gestión de categorías no está incluida en esta fase; se puede
          agregar una fila directamente en la tabla <code>categories</code> si se necesita.
        </p>
      )}
    </main>
  );
}
