import type { Metadata } from 'next';
import { CategoryFilter } from '@/ui/components/photo-portfolio/category-filter';
import { GalleryGrid } from '@/ui/components/photo-portfolio/gallery-grid';
import { photos, photosByCategory } from '@/data/photos';
import { CATEGORY_LABELS, PhotoCategory } from '@/data/schema';

export const metadata: Metadata = {
  title: '作品集 · 林间',
  description: '按分类浏览林间的全部摄影作品：人像、风光、街头、建筑、生态。',
};

interface GalleryPageProps {
  searchParams?: Promise<{ cat?: string | string[] }> | { cat?: string | string[] };
}

const VALID_CATEGORIES = new Set<string>(Object.keys(CATEGORY_LABELS));

function resolveCategory(raw: string | string[] | undefined): PhotoCategory | 'all' {
  if (!raw) return 'all';
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return 'all';
  return VALID_CATEGORIES.has(v) ? (v as PhotoCategory) : 'all';
}

export default async function GalleryPage({ searchParams }: GalleryPageProps) {
  // Next 15: searchParams is a Promise on the server.
  const sp = searchParams ? await Promise.resolve(searchParams) : undefined;
  const cat = resolveCategory(sp?.cat);

  const visible = cat === 'all' ? photos : photosByCategory[cat] ?? [];
  const heading = cat === 'all' ? '全部作品' : CATEGORY_LABELS[cat];

  return (
    <>
      <header className="pp-page-head">
        <div className="pp-container">
          <span className="pp-page-head__eyebrow">作品集 · Gallery</span>
          <h1 className="pp-page-head__title">{heading}</h1>
          <p className="pp-page-head__lead">
            共 {visible.length} 张作品。点击任意一张可查看大图与拍摄参数。
          </p>
        </div>
      </header>

      <section className="pp-container pp-section">
        <div className="pp-gallery-header">
          <CategoryFilter active={cat} />
        </div>
        <GalleryGrid photos={visible} />
      </section>
    </>
  );
}
