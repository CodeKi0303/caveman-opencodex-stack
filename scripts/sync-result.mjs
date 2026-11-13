// Share the same outcome wording between the terminal and double-click sync.
export function syncResultMessage(result) {
  const messages=[];
  if(result.catalogChanged)messages.push('모델 목록 갱신 완료.');
  if(result.cacheChanged)messages.push(result.cacheRepaired?'Codex 모델 캐시를 복구했습니다.':'Codex 모델 캐시를 갱신했습니다.');
  if(result.configChanged)messages.push('모델 목록 경로 설정을 복구했습니다.');
  if(!messages.length)messages.push('모델 목록과 캐시가 정상이며 변경이 없습니다.');
  if(result.restartCodex)messages.push('변경 사항을 적용하려면 Codex를 재시작해 주세요.');
  if(result.warnings?.length)messages.push('연결 설정에 경고가 있습니다. doctor로 확인해 주세요.');
  return messages.join(' ');
}
