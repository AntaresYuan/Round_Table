import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExifPanel } from '@/ui/components/photo-portfolio/exif-panel';
import {
  getAdjacentPhotos,
  getPhotoBySlug,
  photos,
} from '@/data/photos';
import { CATEGORY_LABELS } from '@/data/schema';

interface DetailPageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams(): Array<{ slug: string }> {
  return photos.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata(
  { params }: DetailPageProps,
): Promise<Metadata> {
  const { slug } = await params;
  const photo = getPhotoBySlug(slug);
  if (!photo) return { title: '作品未找到 · 林间' };
  return {
    title: `${photo.title} · 林间`,
    description: photo.description,
    openGraph: {
      title: photo.title,
      description: photo.description,
      images: [{ url: photo.src, width: photo.width, height: photo.height }],
    },
  };
}

export default async function PhotoDetailPage({ params }: DetailPageProps) {
  const { slug } = await params;
  const photo = getPhotoBySlug(slug);
  if (!photo) notFound();

  const { prev, next } = getAdjacentPhotos(slug);

  return (
    <article className="pp-container pp-detail">
      <nav className="pp-detail__nav" aria-label="作品导航">
        <Link href="/photo-portfolio/gallery" aria-label="返回作品集列表">
          ← 作品集
        </Link>
        <div style={{ display: 'flex', gap: 8 }}>
          {prev ? (
            <Link
              href={`/photo-portfolio/gallery/${prev.slug}`}
              aria-label={`上一张：${prev.title}`}
            >
              ‹ {prev.title}
            </Link>
          ) : (
            <span style={{ opacity: 0.4 }}>已是第一张</span>
          )}
          {next ? (
            <Link
              href={`/photo-portfolio/gallery/${next.slug}`}
              aria-label={`下一张：${next.title}`}
            >
              {next.title} ›
            </Link>
          ) : (
            <span style={{ opacity: 0.4 }}>已是最后一张</span>
          )}
        </div>
      </nav>

      <div className="pp-detail__hero">
        <img
          src={photo.src}
          alt={photo.title}
          width={photo.width}
          height={photo.height}
        />
      </div>

      <div className="pp-detail__body">
        <div>
          <span className="pp-detail__cat">{CATEGORY_LABELS[photo.category]}</span>
          <h1 className="pp-detail__title">{photo.title}</h1>
          <p className="pp-detail__description">{photo.description}</p>
        </div>
        <ExifPanel exif={photo.exif} />
      </div>
    </article>
  );
}
