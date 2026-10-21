/** Tool successes are evidence of separate operations, never proof of visual accuracy. */
export class PdfTaskOutcome {
  private generated = new Set<string>();
  private presented = new Set<string>();
  observeToolResult(name: string, result: any): void {
    if (result?.isError) return;
    if (name === 'pdf_export' && result?.details?.pdfExported === true && typeof result.details.outputPath === 'string') {
      this.generated.add(result.details.outputPath);
    }
    if (name === 'present_file') {
      try {
        const receipt = JSON.parse((result?.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n'));
        if (receipt.ok === true && receipt.action === 'present_file' && typeof receipt.path === 'string') this.presented.add(receipt.path);
      } catch { /* no success inferred from malformed receipts */ }
    }
  }
  snapshot(reviewIncomplete: boolean) {
    return { generatedPaths: [...this.generated], presentedPaths: [...this.presented], review: reviewIncomplete ? 'incomplete' : 'recorded_or_not_required' };
  }
  incompleteReviewNotice(): string {
    const generated = this.generated.size ? 'PDF 생성은 완료됐습니다. ' : '';
    const presented = this.presented.size ? '파일 링크는 채팅에 남아 있습니다. ' : '';
    return generated + presented + '다만 PDF 관찰 기록이 누락되어 시각 검토 완료로 처리하지 않았습니다. 기존 결과물을 확인한 뒤 필요한 검토만 이어가면 됩니다. 관찰 기록이 없는 완료 주장은 공개하지 않았습니다.';
  }
}
