README.md: README.Rmd public/data/size_report.tsv
	Rscript -e "rmarkdown::render('README.Rmd', output_format = 'github_document', quiet = TRUE)"

readme: README.md

assets:
	Rscript scripts/build_assets.R

check:
	Rscript -e "rmarkdown::render('README.Rmd', output_format = 'github_document', quiet = TRUE)"
	npm test
	Rscript scripts/smoke_vcf_ingest.R

serve:
	npm run serve

.PHONY: readme assets check serve
