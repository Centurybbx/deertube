import { z } from "zod";
import { baseProcedure, createTRPCRouter } from "../init";
import { getCdpBrowserController } from "../../cdp-browser";

const referenceSchema = z.object({
  refId: z.number().int().positive(),
  text: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});

const validationStatusSchema = z.enum([
  "idle",
  "running",
  "complete",
  "failed",
]);

export const cdpBrowserRouter = createTRPCRouter({
  open: baseProcedure
    .input(
      z.object({
        url: z.string().min(1),
        reference: referenceSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const controller = getCdpBrowserController();
      return controller.open({
        url: input.url,
        reference: input.reference,
      });
    }),
  captureValidationSnapshot: baseProcedure
    .input(
      z.object({
        sessionId: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const controller = getCdpBrowserController();
      const snapshot = await controller.captureValidationSnapshot(input.sessionId);
      return { snapshot };
    }),
  setValidationState: baseProcedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        status: validationStatusSchema,
        message: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const controller = getCdpBrowserController();
      await controller.setValidationIndicator({
        sessionId: input.sessionId,
        status: input.status,
        message: input.message,
      });
      return { ok: true };
    }),
});

export type CdpBrowserRouter = typeof cdpBrowserRouter;
