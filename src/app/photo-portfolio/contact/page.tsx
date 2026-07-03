import type { Metadata } from 'next';
import { ContactForm } from '@/ui/components/photo-portfolio/contact-form';

export const metadata: Metadata = {
  title: '联系预约 · 林间',
  description: '提交一次拍摄预约，或就作品集合作 / 媒体邀约与我们联系。',
};

export default function ContactPage() {
  return (
    <section className="pp-container">
      <header className="pp-page-head">
        <span className="pp-page-head__eyebrow">联系 · Contact</span>
        <h1 className="pp-page-head__title">预约一次拍摄</h1>
        <p className="pp-page-head__lead">
          工作室位于上海，接受国内外的拍摄委托。请在下方留下您的需求，我们会在 24 小时内回复邮件确认档期与报价。
        </p>
      </header>

      <div className="pp-contact">
        <aside aria-label="联系方式">
          <h2 className="pp-contact__title" style={{ fontSize: 24, marginBottom: 12 }}>
            工作室信息
          </h2>
          <p className="pp-contact__lead">
            我们的工作流是慢的：每个项目从咨询到交付，通常需要 2–6 周。如果您有具体的时间窗，请在表单里写清楚。
          </p>
          <div className="pp-contact__details">
            <div>
              <strong>邮箱</strong>
              <a href="mailto:hello@lin.studio">hello@lin.studio</a>
            </div>
            <div>
              <strong>电话</strong>
              <a href="tel:+862112345678">+86 21 1234 5678</a>
            </div>
            <div>
              <strong>地址</strong>
              <span>上海市徐汇区 · 永康路</span>
            </div>
            <div>
              <strong>工作日</strong>
              <span>周二 — 周六，10:00 – 19:00</span>
            </div>
          </div>
        </aside>

        <ContactForm />
      </div>
    </section>
  );
}
