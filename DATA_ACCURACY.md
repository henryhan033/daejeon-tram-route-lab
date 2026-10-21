# 데이터 출처 및 정확도

- 대중교통 길찾기: Transitous/MOTIS 공개 API. 실제 제공 경로는 서비스가 가진 시간표·노선 데이터 범위에 따라 달라집니다.
- 주소·장소 검색: Transitous/MOTIS, Photon/OpenStreetMap 및 Nominatim/OpenStreetMap 공개 지오코더. API 키 없이 사용할 수 있지만, 한국의 모든 주소·건물·POI가 등록되어 있는 것은 아닙니다.
- 검색 결과가 이름/주소와 일치하는지 사용자가 후보를 직접 선택하도록 하며, 검색어와 관련 없는 후보는 필터링합니다. 공개 데이터에 정확한 항목이 없으면 검색 실패할 수 있습니다.
- 대전 트램 45개 정거장 이름과 상세 위치 도면은 대전광역시 공식 자료를 참고합니다.
  - 정거장 상세 위치 도면: https://www.daejeon.go.kr/dsi/DsiNoticeView.do?menuSeq=3278&ntatcSeq=1465290799
- 앱의 정거장 좌표 일부는 주변 랜드마크 지오코딩 기반 근사값입니다. CAD/도면에서 공식 측량 좌표를 추출해 검증한 결과로 간주하면 안 됩니다.
- 앱은 공식 트램 선로 중심선이 확보되지 않은 상태에서 실제 선로를 정확히 표시한다고 주장하지 않습니다. 트램 시간 비교는 사용자가 지정한 속도·배차간격·정차시간 가정에 따른 시뮬레이션입니다.


## v1.13.3 건물 후보 비교
- 후보 목록에 이름·장소 유형·주소·제공된 지번 주소·지역 정보를 분리해 표시합니다.
- 후보 선택 시 위치 미리보기와 선택 주소 요약을 표시합니다.
- 키보드 위/아래와 Enter로 후보를 탐색할 수 있으며, 아무 후보도 확정되지 않으면 경로 계산을 진행하지 않습니다.
- 도로명 주소와 지번 주소 변환은 공개 제공자가 실제 값을 반환했을 때만 표시합니다.


## v1.13.6 known-building fallback
- The search includes a verified alias entry for 미라클빌딩, at 대전광역시 서구 둔산로 52 / 대전광역시 서구 둔산동 1169.
- Building coordinate reference: approx. 36.35103287, 127.37972381. This represents the building address point; it may not be the entrance or a particular tenant.
- The entry is a targeted fallback for a building absent from free geocoder results; it is not a complete building registry.


## v1.13.7 일반 건물 검색 범위
- 후보 검색은 Transitous ADDRESS, Transitous PLACE, Photon 및 Nominatim 검색 결과를 합칩니다. Nominatim 설정은 공식 Search API의 `addressdetails`, `namedetails`, `countrycodes`, `viewbox`, `bounded` 옵션을 사용합니다.
- 확인된 별칭 데이터는 공개 지오코더 결과를 대체하지 않고 후보 목록에 추가로 병합됩니다. 따라서 해당 건물 한 곳만 검색하도록 고정하지 않습니다.
- 이 방식은 공개 OSM 데이터에 등록된 건물·POI를 더 넓게 찾기 위한 개선입니다. 어떤 공급자에도 등록되지 않은 건물이나 별칭은 나타나지 않을 수 있으며, 지번 주소가 제공되지 않으면 임의로 생성하지 않습니다.
