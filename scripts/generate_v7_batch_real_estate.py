#!/usr/bin/env python3
"""
V7 부동산 관련 계약서 배치 생성
- 기존 50개 리프 + 새 카테고리 ~16개 추가
- 생성 후 sidebar_data idx를 document_templates_v7.id로 즉시 업데이트
"""
import json, time, requests, psycopg2

FASTAPI_URL = "http://100.108.86.92:8001"
DB_HOST = "15.165.123.6"
DB_NAME = "lemon"
DB_USER = "lemon"
DB_PASS = "081908"
CREATED_BY = 72
MODEL = "gpt-4o"
SIDEBAR_TITLE = "mainMenuContractData_v7"

NEW_CATEGORIES = [
    {
        "title": "부동산 중개 계약서",
        "subMenu": [
            {"title": "부동산 중개계약서 (일반)", "description": "공인중개사와 매도인(또는 임대인) 간 일반 중개계약"},
            {"title": "부동산 전속중개 계약서", "description": "공인중개사에게 독점적 중개권을 부여하는 전속중개계약"},
            {"title": "부동산 공동중개 계약서", "description": "복수의 공인중개사가 공동으로 중개를 수행하는 계약"},
        ],
    },
    {
        "title": "부동산 개발·건축 계약서",
        "subMenu": [
            {"title": "토지 개발계약서", "description": "토지를 매입하여 개발하기 위한 토지 개발 계약"},
            {"title": "건축공사 도급계약서", "description": "건물 신축 또는 증축 공사를 도급인과 수급인 간에 체결하는 계약"},
            {"title": "시행사·시공사 계약서", "description": "부동산 개발 시행사와 시공사 간의 공사 및 개발 계약"},
            {"title": "건축 분양대행 계약서", "description": "시행사가 분양업체에 분양 업무를 위탁하는 계약"},
            {"title": "공사대금 지급 약정서", "description": "공사 완료 후 공사대금 지급 조건 및 일정을 약정하는 서류"},
            {"title": "건축 감리 계약서", "description": "건축공사 감리 용역 제공을 위한 감리자와 건축주 간의 계약"},
        ],
    },
    {
        "title": "재건축·재개발 계약서",
        "subMenu": [
            {"title": "재건축조합 가입계약서", "description": "재건축 사업에 참여하기 위해 조합에 가입하는 계약"},
            {"title": "관리처분계획 동의서", "description": "재건축·재개발 관리처분계획에 동의하는 서류"},
            {"title": "이주비 대출 계약서", "description": "재건축·재개발로 인한 이주 시 이주비 대출에 관한 계약"},
            {"title": "상가 재건축 동의서", "description": "상가 건물 재건축을 위한 구분소유자 동의서"},
        ],
    },
    {
        "title": "부동산 경매·공매 계약서",
        "subMenu": [
            {"title": "경매 낙찰 부동산 매매계약서", "description": "경매에서 낙찰된 부동산의 소유권 이전을 위한 매매계약"},
            {"title": "공매 낙찰 부동산 취득 계약서", "description": "공매(한국자산관리공사 등)에서 낙찰된 부동산 취득 계약"},
            {"title": "유입주택 매매계약서", "description": "금융기관이 담보권 실행으로 취득한 유입주택 매각 계약"},
        ],
    },
]

NEW_ITEMS_IN_EXISTING = {
    "부동산 매매 관련 계약서": [
        {"title": "농지 매매계약서", "description": "농업 목적으로 사용되는 농지를 매매하기 위한 계약서. 농지취득자격증명, 농지보전부담금 등 농지 관련 특수 조건 포함"},
    ],
    "부동산 임대차 관련 계약서": [
        {"title": "오피스텔 임대차계약서", "description": "오피스텔(주거 겸 업무용)을 임대·임차하기 위한 계약서"},
        {"title": "물류창고 임대차계약서", "description": "물류창고 및 보관시설을 임대·임차하기 위한 계약서"},
        {"title": "주차장 임대차계약서", "description": "주차장 및 주차 공간을 임대·임차하기 위한 계약서"},
    ],
}

DETAIL_OVERRIDES = {
    "일반적인 부동산 매매계약서": ("계약서", "매도인: 김철수, 매수인: 이영희, 서울시 강남구 역삼동 123-45 아파트 101동 1001호(전용 84㎡), 매매대금 10억원, 계약금 1억원, 잔금 9억원"),
    "토지 매매계약서": ("계약서", "매도인: 김철수, 매수인: 이영희, 경기도 용인시 수지구 123번지 대지 500㎡, 매매대금 15억원"),
    "수익형 부동산 매매계약서": ("계약서", "매도인: 김철수, 매수인: 이영희, 서울시 마포구 상수동 상가건물(1~3층), 매매대금 20억원, 현행 임대 수익 월 800만원"),
    "공동구매 부동산 매매계약서": ("계약서", "매수인1: 김철수(50%), 매수인2: 이영희(50%), 경기도 성남시 분당구 오피스빌딩, 매매대금 30억원, 공동소유 지분 및 운영 방식 명시"),
    "사후 부동산 매매계약서": ("계약서", "매도인: 김철수, 매수인: 이영희, 서울시 서초구 아파트, 매매 완료 후 하자담보책임 및 사후 정산 조건 포함"),
    "농지 매매계약서": ("계약서", "매도인: 김철수, 매수인: 이영희, 충청북도 청주시 농지 1,000㎡, 매매대금 3억원, 농지취득자격증명 취득 조건부"),
    "경매 낙찰 부동산 매매계약서": ("계약서", "낙찰자: 이영희, 매각법원: 서울중앙지방법원, 사건번호 2025타경12345, 낙찰가 8억원, 명도 조건 및 권리분석 포함"),
    "공매 낙찰 부동산 취득 계약서": ("계약서", "낙찰자: 이영희, 공매기관: 한국자산관리공사, 물건번호 2025-001, 낙찰가 5억원, 공매조건 및 인도 절차 포함"),
    "유입주택 매매계약서": ("계약서", "매도인: 주식회사 레몬은행, 매수인: 이영희, 서울시 노원구 아파트(유입 취득 물건), 매각가 6억원, 현상 매각 조건"),
    "주거용 임대차계약서": ("계약서", "임대인: 김철수, 임차인: 이영희, 서울시 강남구 역삼동 아파트 101호(전용 84㎡), 보증금 5000만원, 월세 150만원, 임대기간 2년"),
    "상가 임대차계약서": ("계약서", "임대인: 김철수, 임차인: 이영희, 서울시 강남구 테헤란로 1층 상가(60㎡), 보증금 1억원, 월세 500만원, 임대기간 2년"),
    "토지 임대차계약서": ("계약서", "임대인: 김철수, 임차인: 이영희, 경기도 하남시 토지 1,000㎡(건축 용도), 보증금 2000만원, 월세 100만원, 임대기간 5년"),
    "단기 부동산 임대차계약서": ("계약서", "임대인: 김철수, 임차인: 이영희, 서울시 종로구 오피스 1층(30㎡), 보증금 500만원, 월세 80만원, 임대기간 6개월"),
    "부동산 전세계약서": ("계약서", "임대인: 김철수, 임차인: 이영희, 서울시 마포구 아파트 301호, 전세금 3억원, 계약기간 2년"),
    "부동산 임대관리 계약서": ("계약서", "임대인: 김철수, 임대관리사: 레몬부동산관리, 관리 대상: 오피스텔 10실, 관리수수료 월세의 5%, 계약기간 1년"),
    "공유오피스 임대차 계약서": ("계약서", "임대인: 천레몬 주식회사, 임차인: 이영희, 서울시 강남구 공유오피스 A호, 월 이용료 50만원(고정석 2석), 계약기간 1년"),
    "임대차 갱신 계약서": ("계약서", "임대인: 김철수, 임차인: 이영희, 서울시 강남구 아파트, 기존 계약 만료 후 2년 갱신, 보증금 2000만원 인상, 월세 동결"),
    "부분 임대차 계약서": ("계약서", "임대인: 김철수, 임차인: 이영희, 서울시 마포구 빌딩 2층 일부(100㎡ 중 50㎡), 보증금 3000만원, 월세 200만원"),
    "임대차 종료 계약서": ("계약서", "임대인: 김철수, 임차인: 이영희, 서울시 강남구 아파트, 임대차 계약 합의 종료, 보증금 반환 조건 및 원상복구 사항 명시"),
    "오피스텔 임대차계약서": ("계약서", "임대인: 김철수, 임차인: 이영희, 서울시 강남구 오피스텔 1205호(전용 34㎡, 주거용), 보증금 5000만원, 월세 80만원, 임대기간 1년"),
    "물류창고 임대차계약서": ("계약서", "임대인: 김철수, 임차인: 천레몬 주식회사, 경기도 이천시 물류창고 2,000㎡, 보증금 5000만원, 월세 400만원, 임대기간 2년"),
    "주차장 임대차계약서": ("계약서", "임대인: 김철수, 임차인: 이영희, 서울시 중구 지하주차장 10면, 보증금 500만원, 월 이용료 50만원, 임대기간 1년"),
    "부동산 관리 신탁계약서": ("계약서", "위탁자: 김철수, 수탁자: 레몬자산신탁, 신탁 부동산: 서울시 강남구 빌딩, 관리 범위: 임대차 관리·수선·보수, 신탁 기간 5년"),
    "부동산 개발 신탁계약서": ("계약서", "위탁자: 김철수, 수탁자: 레몬자산신탁, 신탁 토지: 경기도 용인시 2,000㎡, 개발 목적: 주상복합 신축, 개발 비용 50억원"),
    "부동산 담보 신탁계약서": ("계약서", "위탁자: 김철수, 수탁자: 레몬자산신탁, 수익자: 주식회사 레몬은행, 담보 부동산: 서울시 서초구 아파트, 담보대출 5억원"),
    "부동산 처분 신탁계약서": ("계약서", "위탁자: 김철수, 수탁자: 레몬자산신탁, 신탁 목적: 부동산 처분·매각, 처분 후 수익 배분 조건 명시"),
    "부동산 후견 신탁계약서": ("계약서", "위탁자: 김철수(치매 우려), 수탁자: 레몬자산신탁, 후견 대상 부동산: 서울 아파트 및 토지, 신탁 목적: 재산 보호 및 관리"),
    "부동산 사업수익 신탁계약서": ("계약서", "위탁자: 김철수, 수탁자: 레몬자산신탁, 신탁 부동산 개발 사업수익을 수익자들에게 배분하는 사업수익신탁"),
    "부동산 공공 신탁계약서": ("계약서", "위탁자: 김철수, 수탁자: 공공신탁기관, 공공임대 목적 신탁, 시세의 80% 임대료 제공 조건"),
    "부동산 임대차 신탁계약서": ("계약서", "위탁자: 김철수(임대인), 수탁자: 레몬자산신탁, 임차인: 이영희, 임대차 관계를 신탁 구조로 관리하는 계약"),
    "부동산 유언 신탁계약서": ("계약서", "위탁자: 김철수, 수탁자: 레몬자산신탁, 유언 집행 목적 신탁, 사망 후 부동산을 자녀 이영희에게 이전"),
    "부동산 분양형 신탁계약서": ("계약서", "위탁자(시행사): 천레몬 주식회사, 수탁자: 레몬자산신탁, 분양 부동산: 주상복합 100세대, 분양대금 관리 목적"),
    "부동산 저당권 설정계약서": ("계약서", "채무자: 김철수, 채권자: 주식회사 레몬은행, 저당 부동산: 서울시 강남구 아파트, 채권최고액 5억원, 이율 연 4%"),
    "부동산 근저당권 설정계약서": ("계약서", "채무자: 김철수, 채권자: 주식회사 레몬은행, 근저당 부동산: 서울시 강남구 빌딩, 채권최고액 6억원"),
    "부동산 지상권 설정계약서": ("계약서", "지상권자: 이영희, 토지 소유자: 김철수, 토지: 경기도 성남시 400㎡, 지상권 목적: 건물 신축, 존속기간 30년, 지료 연 500만원"),
    "부동산 임차권 설정계약서": ("계약서", "임차권자: 이영희, 임대인: 김철수, 부동산: 서울시 마포구 상가, 보증금 5000만원, 차임 월 300만원, 존속기간 3년"),
    "부동산 전세권 설정계약서": ("계약서", "전세권자: 이영희, 전세권 설정자: 김철수, 부동산: 서울시 강남구 아파트, 전세금 2억원, 존속기간 2년"),
    "부동산 지역권 설정계약서": ("계약서", "지역권자(요역지): 이영희, 승역지 소유자: 김철수, 지역권 내용: 통행 및 용수 사용, 존속기간 10년, 보상금 1000만원"),
    "부동산 유치권 설정계약서": ("계약서", "유치권자: 레몬건설, 채무자: 김철수, 유치 부동산: 서울시 강남구 공사 건물, 피담보채권: 공사대금 3억원"),
    "부동산 가등기 설정계약서": ("계약서", "가등기권자: 이영희, 가등기 의무자: 김철수, 부동산: 서울시 강남구 아파트, 가등기 원인: 매매예약, 본등기 완료 조건"),
    "부동산 전대차 계약서": ("계약서", "임대인: 김철수, 임차인(전대인): 이영희, 전차인: 박민수, 서울시 강남구 상가 2층, 전대 범위 및 원임대차 조건 준수 명시"),
    "부동산 사용대차 계약서": ("계약서", "대주(무상 제공자): 김철수, 차주: 이영희, 서울시 마포구 주택, 무상 사용기간 1년, 반환 조건 명시"),
    "부동산 사용수익 허가계약서": ("계약서", "허가자: 김철수, 피허가자: 이영희, 경기도 용인시 토지 500㎡, 사용 목적: 텃밭 농사, 허가 기간 1년, 사용료 월 10만원"),
    "부동산 점용허가 계약서": ("계약서", "허가권자: 서울시(관할청), 점용허가 대상: 이영희, 점용 목적: 노상 카페 설치, 점용 면적 20㎡, 점용료 연 500만원"),
    "부동산 단순 교환계약서": ("계약서", "갑: 김철수(서울시 강남구 아파트), 을: 이영희(경기도 성남시 아파트), 등가 교환, 시가 각 5억원, 소유권 동시 이전"),
    "부동산 차액정산 교환계약서": ("계약서", "갑: 김철수(서울 강남구 아파트 7억원), 을: 이영희(경기도 아파트 5억원), 차액 2억원 정산 조건 포함 교환"),
    "부동산 증여계약서": ("계약서", "증여자: 김철수, 수증자: 이영희(자녀), 서울시 강남구 아파트, 증여 가액 10억원, 증여세 신고 및 소유권 이전 조건"),
    "부동산 담보대출 계약": ("계약서", "대주: 주식회사 레몬은행, 차주: 김철수, 담보 부동산: 서울시 강남구 아파트, 대출금 5억원, 이율 연 4.5%, 만기 20년"),
    "부동산 중개계약서 (일반)": ("계약서", "의뢰인: 김철수, 개업공인중개사: 레몬부동산, 중개 대상: 서울시 강남구 아파트 매매, 중개보수 매매가의 0.4%, 계약기간 3개월"),
    "부동산 전속중개 계약서": ("계약서", "의뢰인: 김철수, 전속 개업공인중개사: 레몬부동산, 전속 중개 기간 6개월, 전속 보수 0.5%, 독점 중개권 부여"),
    "부동산 공동중개 계약서": ("계약서", "매도인측 중개사: 레몬부동산A, 매수인측 중개사: 레몬부동산B, 중개 대상: 서울시 강남구 빌딩, 공동 중개보수 분배 조건"),
    "토지 개발계약서": ("계약서", "사업주: 천레몬 주식회사, 개발 토지: 경기도 하남시 2,000㎡, 개발 목적: 주거용 단지, 개발 비용 20억원, 인허가 취득 조건"),
    "건축공사 도급계약서": ("계약서", "도급인: 김철수, 수급인: 레몬건설 주식회사, 공사 목적물: 서울시 강남구 5층 근린생활시설, 공사대금 15억원, 공기 18개월"),
    "시행사·시공사 계약서": ("계약서", "시행사: 천레몬 주식회사, 시공사: 레몬건설 주식회사, 개발 사업: 경기도 하남시 공동주택 200세대, 시공비 150억원"),
    "건축 분양대행 계약서": ("계약서", "시행사: 천레몬 주식회사, 분양대행사: 레몬분양 주식회사, 분양 대상: 오피스텔 100호, 분양대행 수수료 분양가의 2%"),
    "공사대금 지급 약정서": ("계약서", "채무자(발주자): 천레몬 주식회사, 채권자(수급인): 레몬건설, 공사대금 잔금 3억원, 준공 후 30일 이내 지급 약정"),
    "건축 감리 계약서": ("계약서", "건축주: 김철수, 감리자: 레몬감리사무소, 공사: 서울시 강남구 신축 빌딩, 감리 기간 18개월, 감리비 5000만원"),
    "재건축조합 가입계약서": ("계약서", "조합명: 역삼3구역 재건축정비사업조합, 가입자: 김철수(조합원), 분담금 3억원, 종전 자산 평가액 5억원, 가입 조건 및 권리사항"),
    "관리처분계획 동의서": ("계약서", "사업명: 역삼3구역 재건축, 조합원: 김철수, 관리처분계획 주요 내용: 종전자산 5억원 → 종후자산 신축 아파트 84㎡ 배정, 동의 일자"),
    "이주비 대출 계약서": ("계약서", "차주: 김철수(재건축 조합원), 대주: 주식회사 레몬은행, 이주비 대출 2억원, 이율 연 4%, 대출 기간 이주 시작일부터 입주일까지"),
    "상가 재건축 동의서": ("계약서", "구분소유자: 김철수(101호), 건물: 서울시 강남구 노후 상가건물, 재건축 사업 동의, 분담금 및 배정 조건 확인"),
    "공매 낙찰 부동산 취득 계약서": ("계약서", "낙찰자: 이영희, 공매기관: 한국자산관리공사(캠코), 물건번호 2025-K-001, 낙찰가 4억원, 잔금 납부 기한 및 인도 조건"),
}


def make_leaf_item(title, description=""):
    return {
        "title": title,
        "isDisplayedToPublic": [1, 2000],
        "howToDisplayed": "",
        "connectedUrl": "",
        "idx": "",
        "chatGptId": "",
        "sectionType": "ContractContent",
        "dbType": "Contract",
        "icon": "",
        "description": description,
        "isFormal": False,
        "subMenu": [],
    }


def make_category_item(title, sub_items):
    return {
        "title": title,
        "isDisplayedToPublic": [1, 2000],
        "howToDisplayed": "",
        "connectedUrl": "",
        "idx": "",
        "chatGptId": "",
        "sectionType": "ContractContent",
        "dbType": "Contract",
        "icon": "",
        "description": "",
        "isFormal": False,
        "subMenu": [make_leaf_item(s["title"], s.get("description", "")) for s in sub_items],
    }


def find_node_in_list(nodes, title):
    for node in nodes:
        if node.get("title", "") == title:
            return node
        result = find_node_in_list(node.get("subMenu", []), title)
        if result:
            return result
    return None


def collect_leaves(node, result=None):
    if result is None:
        result = []
    sub = node.get("subMenu", [])
    if not sub:
        result.append(node)
    else:
        for child in sub:
            collect_leaves(child, result)
    return result


def check_template_exists(title, conn):
    cur = conn.cursor()
    cur.execute(
        "SELECT id FROM lemon.document_templates_v7 WHERE template_name = %s AND is_deleted = false",
        (title,),
    )
    row = cur.fetchone()
    cur.close()
    return row[0] if row else None


def generate_and_save(title, conn):
    doc_type, detail = DETAIL_OVERRIDES.get(title, ("계약서", f"매도인/임대인: 김철수, 매수인/임차인: 이영희, {title} 관련 기본 사항 포함"))
    print(f"  생성 중: {title}...", end=" ", flush=True)
    try:
        resp = requests.post(
            f"{FASTAPI_URL}/api/v7/generate",
            json={"user_input": f"{title} 문서를 작성해주세요. {detail}", "document_type": doc_type, "model": MODEL, "is_admin": True},
            timeout=180,
        )
        data = resp.json()
        if not data.get("success"):
            print(f"❌ 실패: {data.get('message', data.get('quality_warnings'))}")
            return None

        v7doc = data["v7_document"]
        paras = v7doc.get("pages", [{}])[0].get("paragraphs", [])
        print(f"✅ {len(paras)}p", end="")

        cur = conn.cursor()
        cur.execute(
            """INSERT INTO lemon.document_templates_v7
               (template_name, description, category, template_json, created_by, is_public, is_system, language, created_at, updated_at)
               VALUES (%s, %s, %s, %s::jsonb, %s, true, true, 'ko', NOW(), NOW()) RETURNING id""",
            (title, detail[:200], "부동산 관련 계약서", json.dumps(v7doc, ensure_ascii=False), CREATED_BY),
        )
        new_id = cur.fetchone()[0]
        cur.execute(
            "UPDATE lemon.document_templates_v7 SET template_group_id = %s WHERE id = %s AND template_group_id IS NULL",
            (new_id, new_id),
        )
        conn.commit()
        cur.close()
        print(f" → id={new_id}")
        return new_id
    except Exception as e:
        conn.rollback()
        print(f"❌ 에러: {e}")
        return None


def save_sidebar(sidebar_data, conn):
    cur = conn.cursor()
    cur.execute(
        "UPDATE lemon.sidebar_data SET content = %s::jsonb WHERE title = %s",
        (json.dumps(sidebar_data, ensure_ascii=False), SIDEBAR_TITLE),
    )
    conn.commit()
    cur.close()


def main():
    conn = psycopg2.connect(host=DB_HOST, dbname=DB_NAME, user=DB_USER, password=DB_PASS)

    cur = conn.cursor()
    cur.execute("SELECT content FROM lemon.sidebar_data WHERE title = %s", (SIDEBAR_TITLE,))
    row = cur.fetchone()
    cur.close()
    sidebar_data = row[0] if row else []
    if isinstance(sidebar_data, str):
        sidebar_data = json.loads(sidebar_data)

    re_node = find_node_in_list(sidebar_data, "부동산 관련 계약서")
    if not re_node:
        print("❌ '부동산 관련 계약서' 노드를 찾을 수 없습니다.")
        conn.close()
        return

    existing_titles = {s["title"] for s in re_node.get("subMenu", [])}
    added = 0
    for new_cat in NEW_CATEGORIES:
        if new_cat["title"] not in existing_titles:
            print(f"  카테고리 추가: {new_cat['title']} ({len(new_cat['subMenu'])}개)")
            re_node["subMenu"].append(make_category_item(new_cat["title"], new_cat["subMenu"]))
            added += 1

    for cat_title, new_items in NEW_ITEMS_IN_EXISTING.items():
        cat_node = find_node_in_list(sidebar_data, cat_title)
        if cat_node:
            existing = {s["title"] for s in cat_node.get("subMenu", [])}
            for item in new_items:
                if item["title"] not in existing:
                    print(f"  항목 추가: {item['title']} → {cat_title}")
                    cat_node["subMenu"].append(make_leaf_item(item["title"], item.get("description", "")))
                    added += 1

    if added:
        save_sidebar(sidebar_data, conn)
        print(f"✅ 사이드바 구조 업데이트 완료 ({added}개 추가)")
    else:
        print("✅ 사이드바 구조 이미 최신")

    all_leaves = collect_leaves(re_node)
    print(f"\n총 리프 {len(all_leaves)}개 처리 시작")

    success = failed = skipped = 0

    for leaf in all_leaves:
        title = leaf.get("title", "")
        if not title:
            continue

        existing_idx = leaf.get("idx", "")
        if existing_idx and str(existing_idx).strip() and str(existing_idx) != "0":
            print(f"  ⏭️ 스킵 (idx={existing_idx}): {title}")
            skipped += 1
            continue

        existing_id = check_template_exists(title, conn)
        if existing_id:
            print(f"  ⏭️ DB 기존 (id={existing_id}): {title} → idx 업데이트")
            leaf["idx"] = existing_id
            save_sidebar(sidebar_data, conn)
            skipped += 1
            continue

        new_id = generate_and_save(title, conn)
        if new_id:
            leaf["idx"] = new_id
            save_sidebar(sidebar_data, conn)
            success += 1
        else:
            failed += 1

        time.sleep(5)

    conn.close()
    print(f"\n📊 결과: 신규={success}, 스킵={skipped}, 실패={failed}")


if __name__ == "__main__":
    main()
