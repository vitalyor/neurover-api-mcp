export function generationSummary(value) {
  const g=value.generation||value.latest_run?.generation||{};
  const outputs=value.outputs||g.outputs||(value.primary_media?[value.primary_media]:[]);
  return {
    id:value.id,messageId:value.role?value.id:undefined,nodeId:value.type?value.id:undefined,
    generationId:value.generation_request_id||g.id,status:value.status,
    generationFailed:['failed','moderated'].includes(value.status),
    model:value.model_name||g.model,modelId:value.model_id||value.ai_model_id,
    processingStage:g.processing_stage,error_code:value.error_code||g.error_code||null,
    error_message:value.error_message||g.error_message||value.output?.error_message||null,
    moderationStatus:g.moderation_status,moderationReasonCode:g.moderation_reason_code,
    settlementStatus:g.settlement_status,
    estimatedCredits:Number.isFinite(value.reserve_price?.credits_minor)?value.reserve_price.credits_minor/100:undefined,
    finalCredits:Number.isFinite(value.final_price?.credits_minor)?value.final_price.credits_minor/100:Number.isFinite(g.final_credits_minor)?g.final_credits_minor/100:undefined,
    outputs:outputs.map(m=>({id:m.id||m.media_asset_id,type:m.media_type,mimeType:m.mime_type,width:m.width,height:m.height,bytes:m.size_bytes})),
    timedOut:value.timedOut,updatedAt:value.updated_at||g.updated_at,
  };
}
export function submissionSummary(r) {
  return {status:r.status,account:r.account,workflowId:r.workflowId,requestId:r.requestId,estimatedCredits:r.estimatedCredits,replayed:r.replayed,user_message:r.user_message?{id:r.user_message.id}:undefined,assistant_message:r.assistant_message?generationSummary(r.assistant_message):undefined,run:r.run?{id:r.run.id,status:r.run.status}:undefined,enhancement:r.enhancement?{id:r.enhancement.id,uuid:r.enhancement.uuid,status:r.enhancement.status}:undefined};
}
