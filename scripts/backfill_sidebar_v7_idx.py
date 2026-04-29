#!/usr/bin/env python3
"""
V7 sidebar idx 백필 마이그레이션
- document_templates_v7 기존 템플릿들을 sidebar_data의 idx에 매핑
- 모든 _v7 sidebar_data 항목의 leaf 노드를 순회
- template_name 매치 시 해당 노드의 idx를 template id로 업데이트
"""
import json
import psycopg2

DB_HOST = "15.165.123.6"
DB_NAME = "lemon"
DB_USER = "lemon"
DB_PASS = "081908"


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


def main():
    conn = psycopg2.connect(host=DB_HOST, dbname=DB_NAME, user=DB_USER, password=DB_PASS)
    cur = conn.cursor()

    # 1. document_templates_v7 전체 로드 (name → id)
    cur.execute("SELECT id, template_name FROM lemon.document_templates_v7 WHERE is_deleted = false")
    template_map = {}
    for tid, tname in cur.fetchall():
        if tname:
            template_map[tname.strip()] = tid
    print(f"V7 템플릿 수: {len(template_map)}")

    # 2. _v7 suffix 또는 v7 관련 sidebar_data 항목 조회
    cur.execute("SELECT id, title, content FROM lemon.sidebar_data WHERE title LIKE '%v7%' OR title LIKE '%V7%'")
    sidebar_rows = cur.fetchall()
    print(f"대상 sidebar_data 항목: {len(sidebar_rows)}개")

    total_updated = 0

    for sid, stitle, content in sidebar_rows:
        if not content:
            continue
        try:
            if isinstance(content, str):
                data = json.loads(content)
            else:
                data = content
        except Exception as e:
            print(f"  ❌ JSON 파싱 실패 ({stitle}): {e}")
            continue

        leaves = []
        if isinstance(data, list):
            for item in data:
                collect_leaves(item, leaves)
        elif isinstance(data, dict):
            collect_leaves(data, leaves)

        updated = 0
        for leaf in leaves:
            title = leaf.get("title", "").strip()
            if not title:
                continue
            # idx가 이미 숫자 값이면 스킵
            existing_idx = leaf.get("idx", "")
            if existing_idx and str(existing_idx).strip() and str(existing_idx) != "0":
                continue  # 이미 idx 있음 (V5 포함)
            # V7 매치
            if title in template_map:
                leaf["idx"] = template_map[title]
                updated += 1

        if updated > 0:
            total_updated += updated
            print(f"  [{sid}] {stitle}: {updated}개 idx 업데이트")
            cur.execute(
                "UPDATE lemon.sidebar_data SET content = %s::jsonb WHERE id = %s",
                (json.dumps(data, ensure_ascii=False), sid),
            )
            conn.commit()

    cur.close()
    conn.close()
    print(f"\n총 {total_updated}개 노드 idx 업데이트 완료")


if __name__ == "__main__":
    main()
