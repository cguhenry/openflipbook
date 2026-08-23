import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getNode, type NodeRow } from "@/lib/db";
import { readServerEnv } from "@/lib/env";
import { formatUi, getStrings } from "@/lib/i18n";
import { nodeImagePath } from "@/lib/node-image";
import PermalinkImage from "@/components/permalink-image";

const t = getStrings("zh-TW");

interface PermalinkPageProps {
  params: Promise<{ id: string }>;
}

const cachedGetNode = cache(async (id: string): Promise<NodeRow | null> => {
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB || !env.R2_PUBLIC_BASE_URL) {
    return null;
  }
  try {
    return await getNode(id);
  } catch {
    return null;
  }
});

export async function generateMetadata({
  params,
}: PermalinkPageProps): Promise<Metadata> {
  const { id } = await params;
  const node = await cachedGetNode(id);
  if (!node) {
    return {
      title: t.pageNotFound,
      robots: { index: false, follow: false },
    };
  }
  const imageUrl = nodeImagePath(node.id);
  const title = node.page_title || node.query || t.generatedPage;
  const description = `${t.generatedPage}：「${node.query}」· OpenFlipbook`;
  return {
    title,
    description,
    openGraph: {
      type: "article",
      title,
      description,
      url: `/n/${id}`,
      images: [
        {
          url: imageUrl,
          alt: formatUi(t.generatedIllustrationAlt, { query: node.query }),
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
    alternates: { canonical: `/n/${id}` },
  };
}

export default async function PermalinkPage({ params }: PermalinkPageProps) {
  const { id } = await params;
  const env = readServerEnv();

  if (!env.MONGODB_URI || !env.MONGODB_DB || !env.R2_PUBLIC_BASE_URL) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center px-4 py-16 text-center">
        <h1 className="text-2xl font-bold">{t.persistenceNotConfigured}</h1>
        <p className="mt-4 opacity-70">
          {t.persistenceHelp}
        </p>
        <p className="mt-6 text-xs opacity-60">{t.requestedNode}：<code>{id}</code></p>
      </main>
    );
  }

  const node = await cachedGetNode(id);
  if (!node) notFound();

  const imageUrl = nodeImagePath(node.id);

  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-4 px-4 py-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">{node.page_title}</h1>
        <a
          href={`/play?continue=${encodeURIComponent(node.session_id)}`}
          className="rounded-full border border-[var(--color-ink)]/40 px-3 py-1 text-xs"
        >
          {t.continueThisSession}
        </a>
      </header>
      <PermalinkImage
        nodeId={node.id}
        imageUrl={imageUrl}
        query={node.query}
        sessionId={node.session_id}
      />
      <footer className="text-center text-xs opacity-60">
        {t.queryLabel}：<code>{node.query}</code> · {t.imageLabel}：{node.image_model} · {t.promptLabel}：{" "}
        {node.prompt_author_model}
      </footer>
    </main>
  );
}
