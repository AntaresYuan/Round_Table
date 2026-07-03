import Link from 'next/link';
import { Carousel } from '@/ui/components/photo-portfolio/carousel';
import { PhotoCard } from '@/ui/components/photo-portfolio/photo-card';
import { featuredPhotos, photos } from '@/data/photos';

export default function PhotoPortfolioHomePage() {
  // Carousel shows featured work; below that, a curated cross-section of all
  // categories so the homepage reads as a complete portfolio, not a teaser.
  const curated = photos.slice(0, 6);

  return (
    <>
      <section className="pp-container pp-hero" aria-labelledby="pp-hero-title">
        <span className="pp-hero__eyebrow">Photography · 2018—2025</span>
        <h1 id="pp-hero-title" className="pp-hero__title">
          安静地拍，<br />慢慢地发。
        </h1>
        <p className="pp-hero__lead">
          林间是一个独立摄影项目，记录人像、风光、街头与生态等题材。每一帧都来自一次具体的旅行或一次具体的相遇，没有 AI 生成图，没有摆拍库存。
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Link href="/photo-portfolio/gallery" className="pp-hero__cta">
            浏览作品集 →
          </Link>
          <Link href="/photo-portfolio/contact" className="pp-hero__cta pp-hero__cta--ghost">
            预约拍摄
          </Link>
        </div>
      </section>

      <section className="pp-container" aria-label="精选轮播">
        <Carousel slides={featuredPhotos} />
      </section>

      <section className="pp-container pp-section" aria-labelledby="pp-featured-title">
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 16, marginBottom: 24 }}>
          <h2 id="pp-featured-title" className="pp-page-head__title" style={{ fontSize: 'clamp(24px, 3vw, 32px)' }}>
            最新作品
          </h2>
          <Link
            href="/photo-portfolio/gallery"
            style={{ fontSize: 14, color: 'var(--pp-fg-muted)', borderBottom: '1px solid var(--pp-rule)' }}
          >
            查看全部 →
          </Link>
        </header>
        <div className="pp-featured-grid">
          {curated.map((p, i) => (
            <PhotoCard key={p.id} photo={p} priority={i < 3} />
          ))}
        </div>
      </section>
    </>
  );
}
