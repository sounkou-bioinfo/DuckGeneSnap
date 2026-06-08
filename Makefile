README.md: README.Rmd public/data/size_report.tsv
	Rscript -e "rmarkdown::render('README.Rmd', output_format = 'github_document', quiet = TRUE)"

readme: README.md

assets:
	Rscript scripts/build_assets.R

check:
	Rscript -e "rmarkdown::render('README.Rmd', output_format = 'github_document', quiet = TRUE)"
	node --check src/duckgenesnap.js
	duckdb < sql/locus_join.sql >/dev/null

serve:
	Rscript -e "goserveR::runServer(dir='.', prefix='/', addr='127.0.0.1:8000')"

.PHONY: readme assets check serve
