import os, time, requests, pandas as pd
from io import StringIO
from datetime import datetime, timedelta
from google.cloud import bigquery

FOLDER = "02.TempStorage"
URL    = "https://www2.bmf.com.br/pages/portal/bmfbovespa/boletim1/txref1.asp"

def get_date_range():
    client = bigquery.Client()
    rows = list(client.query("SELECT MAX(data_consulta) as d FROM `eighth-codex-429114-t1.Macro.B3_DiFuturo`").result())
    max_date = datetime.strptime(str(rows[0]["d"]), "%Y%m%d").date()
    today = datetime.today().date()
    return [max_date + timedelta(days=i) for i in range(1, (today - max_date).days + 1)]

def fetch(date_str):
    for attempt in range(1, 4):
        try:
            s = requests.Session()
            s.get(URL, timeout=15)
            r = s.post(URL, data={"Data": date_str, "Consultar": "Consultar"}, timeout=15)
            r.encoding = "latin-1"
            tables = pd.read_html(StringIO(r.text), decimal=",", thousands=".")
            if tables:
                df = max(tables, key=len)
                df["data_consulta"] = datetime.strptime(date_str, "%d/%m/%Y").strftime("%Y%m%d")
                return df
        except Exception as e:
            print(f"  [TENTATIVA {attempt}/3] {date_str}: {e}")
            time.sleep(3)
    return None

def run():
    dates = get_date_range()
    if not dates:
        print("Banco ja atualizado.")
        return

    os.makedirs(FOLDER, exist_ok=True)
    ok = 0
    for d in dates:
        if d.weekday() >= 5:
            continue
        date_str = d.strftime("%d/%m/%Y")
        df = fetch(date_str)
        if df is not None:
            path = os.path.join(FOLDER, f"txref_{d.strftime('%Y%m%d')}.xlsx")
            df.to_excel(path, index=False, engine="openpyxl")
            ok += 1
            print(f"[OK] {date_str}")
        else:
            print(f"[FALHA] {date_str}")
        time.sleep(1)

    print(f"\nConcluido: {ok} datas processadas")

if __name__ == "__main__":
    run()
    print("Etapa 1 concluida. Seguindo para a etapa 2.")
