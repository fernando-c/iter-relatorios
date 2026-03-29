import os, shutil, logging
import pandas as pd
from google.cloud import bigquery
from pathlib import Path

SOURCE   = Path("02.TempStorage")
HIST     = Path("03.Hist")
TABLE_ID = "eighth-codex-429114-t1.Macro.B3_DiFuturo"

def process_data(file_path):
    filename  = os.path.basename(file_path)
    date_part = filename.replace("txref_", "").replace(".xlsx", "").strip()
    df = pd.read_excel(file_path, engine="openpyxl")
    df = df.astype(str).where(pd.notna(df), None)
    data_to_insert = []
    for _, row in df.iterrows():
        data_to_insert.append([date_part, row.iloc[0], row.iloc[1]])
        data_to_insert.append([date_part, row.iloc[0], row.iloc[2]])
    return data_to_insert

def insert_bigquery(data_to_insert):
    client = bigquery.Client()
    rows = []
    for i, data in enumerate(data_to_insert):
        tipo = 252 if i % 2 == 0 else 360
        try:
            dias = float(data[1]) if data[1] is not None else None
            taxa = float(data[2]) if data[2] is not None else None
            rows.append([int(data[0]), tipo, dias, taxa])
        except (ValueError, TypeError):
            continue
    df = pd.DataFrame(rows, columns=["data_consulta", "tipo", "dias", "taxa"])
    job_config = bigquery.LoadJobConfig(
        schema=[
            bigquery.SchemaField("data_consulta", "INTEGER"),
            bigquery.SchemaField("tipo",          "INTEGER"),
            bigquery.SchemaField("dias",          "FLOAT"),
            bigquery.SchemaField("taxa",          "FLOAT"),
        ],
        write_disposition="WRITE_APPEND",
    )
    client.load_table_from_dataframe(df, TABLE_ID, job_config=job_config).result()
    print("[OK] Dados inseridos no BigQuery.")

def run():
    HIST.mkdir(parents=True, exist_ok=True)
    arquivos = [f for f in os.listdir(SOURCE) if f.startswith("txref_") and f.endswith(".xlsx")]
    if not arquivos:
        print("Nenhum arquivo para processar.")
        return
    for filename in arquivos:
        file_path = SOURCE / filename
        print(f"\n{'='*50}\nProcessando: {filename}\n{'='*50}")
        try:
            data = process_data(str(file_path))
            if not data:
                print(f"[AVISO] Sem dados: {filename}")
                continue
            insert_bigquery(data)
            shutil.move(str(file_path), HIST / filename)
            print(f"[OK] Movido para historico: {filename}")
        except Exception as e:
            logging.error(f"[ERRO] {filename}: {e}")

run()
print("Etapa 2 concluida. Seguindo para a etapa 3.")
