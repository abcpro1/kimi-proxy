import { RequestTransform, RequestTransformContext } from "../../types.js";

export class DisableStreamingTransform implements RequestTransform {
  name = "disable-streaming";
  stage: RequestTransform["stage"] = "source";

  applies(context: RequestTransformContext): boolean {
    return context.request.stream === true;
  }

  transform(context: RequestTransformContext): void {
    context.request.state.originalStream = true;
    context.request.stream = false;
    if (context.request.body && typeof context.request.body === "object") {
      context.request.body.stream = false;
    }
  }
}
