import csv,json,collections
from pathlib import Path
p=Path('audit/2026-10-28')
a=[json.loads(x) for x in (p/'history_record_checks.jsonl').read_text(encoding='utf8').splitlines()]
b=[json.loads(x) for x in (p/'history_pdf_checks.jsonl').read_text(encoding='utf8').splitlines()]
key=lambda x:(x['event_id'],x['gender'],x['distance_m'],x['format'],x['name'])
pdf={key(x):x for x in b}
counts=collections.defaultdict(collections.Counter)
for x in a:
 c=counts[x['event_id']]; c['stored']+=1
 if 'overall_rank' in x['checked_fields']: c['api_rank_same']+=1
 elif pdf.get(key(x),{}).get('outcome')=='same_rank': c['pdf_rank_same']+=1
 else: c['rank_unverified']+=1
 c['individual' if x['format']=='individual' else 'relay']+=1
 c['complete_record_checked']+=0
with (p/'history_event_matrix.csv').open(encoding='utf-8-sig',newline='') as f: rows=list(csv.DictReader(f))
fields=['event_id','season','kind','title','coverage','source_kind','stored','individual','relay','api_rank_same','pdf_rank_same','rank_unverified','complete_record_checked']
with (p/'history_verified_matrix.csv').open('w',encoding='utf-8-sig',newline='') as f:
 w=csv.DictWriter(f,fieldnames=fields); w.writeheader()
 for row in rows: w.writerow({**{k:row[k] for k in fields[:6]},**{k:counts[row['event_id']][k] for k in fields[6:]}})
issues=[]
for x in json.loads((p/'dns_start_findings.json').read_text(encoding='utf8')):
 issues.append({**x,'priority':'P1','layer':'statistics','issue_type':'confirmed','page_effect':'event/season/cycle/athlete starts and rate where aggregated','reproduction':'Open the listed C74 page; compare prior best time and DNS with results-model start count','regression':'distinguish prior participation from terminal-round DNS'})
issues.append({'code':'D02/U01','priority':'P1','issue_type':'confirmed','event_id':'2026-27-worldtour-vancouver-1','gender':'mixed','distance_m':2000,'format':'relay','team':'CHN','official_overall_rank':11,'official_round':'quarterfinal heat 4 rank 3, 2:51.826','repository_archive':'missing','detail_page':'quarterfinal heat 4 shown','compare_page':'未收录','source_url':'https://isu-d8g8b4b7ece7aphs.a03.azurefd.net/isudamcontainer/uploads/isunewrevamp/document/original/f287f824479994deccf3aa5b8feffb7cf74f956138eef0e11eda96ad535b31c9.pdf#page=105','first_introduction':'tools/history_data.py:414-458','layer':'projection','regression':'include nonfinal relay teams with official overall classification; do not infer lineup'})
for gender,dist,page in [('women',3000,90),('men',5000,96)]:
 issues.append({'code':'X02','priority':'P0 review','issue_type':'unresolved_official_disagreement','event_id':'2014-15-worldcup-erzurum-6','gender':gender,'distance_m':dist,'format':'relay','team':'CHN','archive_official_rank':1,'current_api_rank':4,'source_url':f'https://app-prod-isu-stk-archive-westeurope.azurewebsites.net/Data/PDFs/WC1415TUR.pdf#page={page}','confidence':'both sources differ; revision ordering not established','regression':'preserve versions and choose evidence-backed latest official final classification'})
for name,gender,dist,status,page in [('ZHOU Yang','women',1500,'PEN',37),('LIU Yang','women',1500,'PEN',37),('ZHANG Hongchao','men',1500,'DNF',44),('HAN Tianyu','men',1000,'PEN',80),('CHEN Dequan','men',1000,'PEN',80)]:
 issues.append({'code':'D06/X02','priority':'P1 review','issue_type':'older_official_source_disagreement','event_id':'2014-15-worldcup-erzurum-6','name':name,'gender':gender,'distance_m':dist,'archive_status':status,'repository_status':'classified','source_url':f'https://app-prod-isu-stk-archive-westeurope.azurewebsites.net/Data/PDFs/WC1415TUR.pdf#page={page}','confidence':'old source differs; current revision not established','layer':'source/status normalization','regression':'retain official status and version; distinguish terminal status from actual starts'})
(p/'findings.json').write_text(json.dumps({'baseline':'dd5adb67c0a71580c2cb70af4bced684cb9c6f5b','as_of':'2026-10-28','issue_counts':{'confirmed_records':9,'older_source_disagreements':7,'final_A_rank_disagreements_unresolved_including_examples':33},'findings':issues},ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print('matrix:',len(rows),'events;',dict(sum(counts.values(),collections.Counter())))

