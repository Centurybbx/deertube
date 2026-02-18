import { z } from "zod";
import { baseProcedure, createTRPCRouter } from "../init";
import { getBrowserViewController } from "../../browserview";

const boundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const highlightSchema = z.object({
  refId: z.number().int().positive(),
  text: z.string().min(1),
  append: z.boolean().optional(),
  showMarker: z.boolean().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  uri: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  validationRefContent: z.string().optional(),
  accuracy: z
    .enum(["high", "medium", "low", "conflicting", "insufficient"])
    .optional(),
  sourceAuthority: z.enum(["high", "medium", "low", "unknown"]).optional(),
  issueReason: z.string().optional(),
  correctFact: z.string().optional(),
});

export const browserViewRouter = createTRPCRouter({
  open: baseProcedure
    .input(
      z.object({
        tabId: z.string(),
        url: z.string(),
        bounds: boundsSchema,
      }),
    )
    .mutation(async ({ input }) => {
      const controller = getBrowserViewController();
      const ok = await controller.open(input.tabId, input.url, input.bounds);
      return { ok };
    }),
  updateBounds: baseProcedure
    .input(
      z.object({
        tabId: z.string(),
        bounds: boundsSchema,
      }),
    )
    .mutation(({ input }) => {
      const controller = getBrowserViewController();
      controller.updateBounds(input.tabId, input.bounds);
      return { ok: true };
    }),
  hide: baseProcedure.mutation(() => {
    const controller = getBrowserViewController();
    controller.hide();
    return { ok: true };
  }),
  hideTab: baseProcedure
    .input(z.object({ tabId: z.string() }))
    .mutation(({ input }) => {
      const controller = getBrowserViewController();
      controller.hideTab(input.tabId);
      return { ok: true };
    }),
  close: baseProcedure
    .input(z.object({ tabId: z.string() }))
    .mutation(({ input }) => {
      const controller = getBrowserViewController();
      controller.close(input.tabId);
      return { ok: true };
    }),
  closeAll: baseProcedure.mutation(() => {
    const controller = getBrowserViewController();
    controller.closeAll();
    return { ok: true };
  }),
  reload: baseProcedure
    .input(z.object({ tabId: z.string() }))
    .mutation(({ input }) => {
      const controller = getBrowserViewController();
      controller.reload(input.tabId);
      return { ok: true };
    }),
  back: baseProcedure
    .input(z.object({ tabId: z.string() }))
    .mutation(({ input }) => {
      const controller = getBrowserViewController();
      controller.goBack(input.tabId);
      return { ok: true };
    }),
  forward: baseProcedure
    .input(z.object({ tabId: z.string() }))
    .mutation(({ input }) => {
      const controller = getBrowserViewController();
      controller.goForward(input.tabId);
      return { ok: true };
    }),
  openExternal: baseProcedure
    .input(z.object({ url: z.string() }))
    .mutation(({ input }) => {
      const controller = getBrowserViewController();
      controller.openExternal(input.url);
      return { ok: true };
    }),
  captureValidationSnapshot: baseProcedure
    .input(z.object({ tabId: z.string() }))
    .mutation(async ({ input }) => {
      const controller = getBrowserViewController();
      const snapshot = await controller.captureValidationSnapshot(input.tabId);
      return { snapshot };
    }),
  highlightReference: baseProcedure
    .input(
      z.object({
        tabId: z.string(),
        reference: highlightSchema,
      }),
    )
    .mutation(async ({ input }) => {
      const controller = getBrowserViewController();
      const ok = await controller.highlightReference(input.tabId, input.reference);
      return { ok };
    }),
  clearReferenceHighlight: baseProcedure
    .input(z.object({ tabId: z.string() }))
    .mutation(async ({ input }) => {
      const controller = getBrowserViewController();
      const ok = await controller.clearReferenceHighlight(input.tabId);
      return { ok };
    }),
});

export type BrowserViewRouter = typeof browserViewRouter;
