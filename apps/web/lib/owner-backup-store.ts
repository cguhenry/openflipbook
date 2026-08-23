import { getDb, getMongoClient } from "./db";
import type { OwnerRestorePlan } from "./owner-backup";
import type { Document } from "mongodb";

type OwnerIdDocument = Document & { _id: string };
type NodeIdDocument = Document & { _id: string; session_id: string };

export async function existingBackupIds(): Promise<{
  sessionIds: Set<string>;
  nodeIds: Set<string>;
}> {
  const db = await getDb();
  const ownerSessionIds = await db.collection<OwnerIdDocument>("session_owners").distinct("_id");
  const nodeSessionIds = await db.collection<NodeIdDocument>("nodes").distinct("session_id");
  const nodeIds = await db.collection<NodeIdDocument>("nodes").distinct("_id");
  return {
    sessionIds: new Set(
      [...ownerSessionIds, ...nodeSessionIds].filter(
        (value): value is string => typeof value === "string",
      ),
    ),
    nodeIds: new Set(nodeIds.filter((value): value is string => typeof value === "string")),
  };
}

/** Atomically makes every restored graph row visible and assigns its owner. */
export async function commitOwnerRestore(
  plan: OwnerRestorePlan,
  ownerToken: string,
): Promise<void> {
  const db = await getDb();
  const client = await getMongoClient();
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      if (plan.sessions.length > 0) {
        await db.collection<OwnerIdDocument>("session_owners").insertMany(
          plan.sessions.map((sessionId) => ({
            _id: sessionId,
            owner_token: ownerToken,
            created_at: new Date(),
          })),
          { session },
        );
      }
      if (plan.nodes.length > 0) {
        await db.collection<NodeIdDocument>("nodes").insertMany(
          plan.nodes.map((node) => ({
            _id: node.id,
            parent_id: node.parent_id,
            source_hotspot_id: node.source_hotspot_id,
            session_id: node.session_id,
            query: node.query,
            page_title: node.page_title,
            image_key: node.image_key,
            image_model: node.image_model,
            prompt_author_model: node.prompt_author_model,
            aspect_ratio: node.aspect_ratio,
            final_prompt: null,
            click_in_parent: node.click_in_parent,
            sources: node.sources,
            relation: node.relation,
            scale: node.scale,
            scale_tier: node.scale_tier,
            scene_view: node.scene_view,
            page_plan: node.page_plan,
            aligned_hotspots: node.aligned_hotspots,
            seed_type: node.seed_type,
            created_at: new Date(node.created_at),
          })),
          { session },
        );
      }
    });
  } finally {
    await session.endSession();
  }
}
