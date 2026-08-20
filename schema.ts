import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export type JobStatus = "pending" | "processing" | "success" | "failed";
export type DetailType = "collar" | "cuff" | "pocket" | "hem";

export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  originalName: text("original_name").notNull(),
  originalPath: text("original_path").notNull(),
  originalUrl: text("original_url").notNull(),
  processedPath: text("processed_path"),
  processedUrl: text("processed_url"),
  status: text("status").$type<JobStatus>().default("pending").notNull(),
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Each row is one independently generated product-detail image.
 * A unique main-task/type pair makes “generate again” safely replace the
 * status/result of that specific detail rather than creating duplicate rows.
 */
export const detailTasks = pgTable(
  "detail_tasks",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    detailType: text("detail_type").$type<DetailType>().notNull(),
    sourcePath: text("source_path").notNull(),
    resultPath: text("result_path"),
    resultUrl: text("result_url"),
    status: text("status").$type<JobStatus>().default("pending").notNull(),
    errorMessage: text("error_message"),
    retryCount: integer("retry_count").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("detail_tasks_task_type_unique").on(table.taskId, table.detailType)]
);
