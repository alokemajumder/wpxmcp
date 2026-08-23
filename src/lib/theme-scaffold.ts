export interface ScaffoldTokens {
  primary?: string;
  accent?: string;
  ink?: string;
  surface?: string;
  font_sans?: string;
  font_serif?: string;
  radius?: string;
}

export interface ScaffoldOptions {
  name: string;
  slug: string;
  description: string;
  author: string;
  tokens: ScaffoldTokens;
}

/**
 * A complete classic PHP theme styled with Tailwind utilities.
 *
 * Classic templates beat generated block markup for this job: the output is
 * readable, diffable, and a model can reason about it without tracking block
 * delimiters. Every design decision lives in theme.css as a custom property,
 * and Tailwind is configured to read those properties — so restyling the site
 * means editing one file, not hunting hex codes through templates.
 */
export function classicThemeScaffold(opts: ScaffoldOptions): Record<string, string> {
  const t = opts.tokens;
  const primary = t.primary ?? "#1d4ed8";
  const accent = t.accent ?? "#0ea5e9";
  const ink = t.ink ?? "#111827";
  const surface = t.surface ?? "#ffffff";
  const fontSans = t.font_sans ?? "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  const fontSerif = t.font_serif ?? "ui-serif, Georgia, Cambria, 'Times New Roman', serif";
  const radius = t.radius ?? "0.75rem";
  const fn = opts.slug.replace(/-/g, "_");

  const files: Record<string, string> = {};

  files["style.css"] = `/*
Theme Name: ${opts.name}
Theme URI: 
Author: ${opts.author}
Description: ${opts.description}
Version: 1.0.0
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
License: GNU General Public License v2 or later
License URI: http://www.gnu.org/licenses/gpl-2.0.html
Text Domain: ${opts.slug}
Tags: custom-menu, featured-images, translation-ready

Styling lives in theme.css (design tokens) plus Tailwind utility classes in the
templates. This file exists for the WordPress theme header and for the handful
of core classes WordPress itself outputs.
*/

/* Core classes WordPress emits that Tailwind does not cover. */
.screen-reader-text {
  position: absolute !important;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0);
  white-space: nowrap; border: 0;
}
.screen-reader-text:focus {
  position: fixed !important;
  top: 1rem; left: 1rem;
  width: auto; height: auto;
  padding: 0.75rem 1rem; margin: 0;
  clip: auto; z-index: 100000;
  background: var(--color-surface); color: var(--color-ink);
  border-radius: var(--radius); box-shadow: 0 10px 30px rgb(0 0 0 / 0.15);
}
.alignleft { float: left; margin-right: 1.5rem; }
.alignright { float: right; margin-left: 1.5rem; }
.aligncenter { display: block; margin-left: auto; margin-right: auto; }
.wp-caption-text { font-size: 0.875rem; opacity: 0.7; margin-top: 0.5rem; }
.sticky, .gallery-caption, .bypostauthor { }
`;

  files["theme.css"] = `/*
 * ${opts.name} — design tokens.
 *
 * This is the single source of truth for the theme's look. Templates reference
 * these via Tailwind classes wired up in functions.php (bg-surface, text-ink,
 * bg-primary, rounded-theme, font-sans …). Change a value here and it changes
 * everywhere — never hardcode a color or radius in a template.
 */
:root {
  /* Color */
  --color-primary: ${primary};
  --color-primary-contrast: #ffffff;
  --color-accent: ${accent};
  --color-ink: ${ink};
  --color-ink-muted: color-mix(in srgb, ${ink} 65%, ${surface});
  --color-surface: ${surface};
  --color-surface-alt: color-mix(in srgb, ${ink} 4%, ${surface});
  --color-border: color-mix(in srgb, ${ink} 12%, ${surface});

  /* Typography */
  --font-sans: ${fontSans};
  --font-serif: ${fontSerif};
  --text-measure: 68ch;

  /* Shape and depth */
  --radius: ${radius};
  --radius-sm: calc(${radius} / 2);
  --radius-lg: calc(${radius} * 1.75);
  --shadow-card: 0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px rgb(0 0 0 / 0.06);

  /* Rhythm */
  --space-section: clamp(3rem, 8vw, 6rem);
  --container: 72rem;
}

@media (prefers-color-scheme: dark) {
  :root[data-theme="auto"] {
    --color-ink: #f3f4f6;
    --color-surface: #0b0f19;
    --color-surface-alt: #131a2a;
    --color-border: #1f2937;
    --color-ink-muted: #9ca3af;
  }
}

html { scroll-behavior: smooth; }
body { font-family: var(--font-sans); color: var(--color-ink); background: var(--color-surface); }

/* Long-form content coming out of the editor, which has no utility classes. */
.entry-content > * + * { margin-top: 1.25em; }
.entry-content h2 { font-size: 1.75rem; font-weight: 700; margin-top: 2.5rem; line-height: 1.25; }
.entry-content h3 { font-size: 1.375rem; font-weight: 600; margin-top: 2rem; line-height: 1.3; }
.entry-content p, .entry-content li { line-height: 1.75; }
.entry-content a { color: var(--color-primary); text-decoration: underline; text-underline-offset: 0.2em; }
.entry-content a:hover { color: var(--color-accent); }
.entry-content ul { list-style: disc; padding-left: 1.5rem; }
.entry-content ol { list-style: decimal; padding-left: 1.5rem; }
.entry-content blockquote {
  border-left: 3px solid var(--color-primary);
  padding-left: 1.25rem; font-style: italic; color: var(--color-ink-muted);
}
.entry-content img { border-radius: var(--radius); max-width: 100%; height: auto; }
.entry-content pre {
  background: var(--color-surface-alt); padding: 1rem;
  border-radius: var(--radius-sm); overflow-x: auto; font-size: 0.875rem;
}
.entry-content code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
.entry-content table { width: 100%; border-collapse: collapse; }
.entry-content th, .entry-content td { border: 1px solid var(--color-border); padding: 0.625rem 0.875rem; text-align: left; }
`;

  files["functions.php"] = `<?php
/**
 * ${opts.name} — theme setup.
 *
 * @package ${opts.name}
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( '${fn.toUpperCase()}_VERSION', '1.0.0' );

/**
 * Theme supports, menus and image sizes.
 */
function ${fn}_setup() {
	add_theme_support( 'title-tag' );
	add_theme_support( 'post-thumbnails' );
	add_theme_support( 'automatic-feed-links' );
	add_theme_support( 'responsive-embeds' );
	add_theme_support( 'align-wide' );
	add_theme_support( 'custom-logo', array(
		'height'      => 64,
		'width'       => 240,
		'flex-height' => true,
		'flex-width'  => true,
	) );
	add_theme_support( 'html5', array( 'search-form', 'comment-form', 'comment-list', 'gallery', 'caption', 'style', 'script' ) );
	add_theme_support( 'custom-background' );
	add_theme_support( 'editor-styles' );
	add_editor_style( 'theme.css' );

	register_nav_menus( array(
		'primary' => __( 'Primary Menu', '${opts.slug}' ),
		'footer'  => __( 'Footer Menu', '${opts.slug}' ),
	) );

	add_image_size( '${opts.slug}-card', 800, 500, true );
}
add_action( 'after_setup_theme', '${fn}_setup' );

/**
 * Styles and scripts.
 *
 * Tailwind is loaded from the Play CDN and configured against the CSS custom
 * properties in theme.css, so utilities such as bg-primary and rounded-theme
 * resolve to the tokens. For production, compile Tailwind and enqueue the built
 * stylesheet here instead of the CDN.
 */
function ${fn}_assets() {
	wp_enqueue_style( '${opts.slug}-style', get_stylesheet_uri(), array(), ${fn.toUpperCase()}_VERSION );
	wp_enqueue_style( '${opts.slug}-tokens', get_theme_file_uri( 'theme.css' ), array( '${opts.slug}-style' ), ${fn.toUpperCase()}_VERSION );

	wp_enqueue_script( '${opts.slug}-tailwind', 'https://cdn.tailwindcss.com/3.4.16', array(), '3.4.16', false );
	wp_add_inline_script( '${opts.slug}-tailwind', ${fn}_tailwind_config(), 'after' );

	if ( is_singular() && comments_open() && get_option( 'thread_comments' ) ) {
		wp_enqueue_script( 'comment-reply' );
	}
}
add_action( 'wp_enqueue_scripts', '${fn}_assets' );

/**
 * Maps the theme.css custom properties onto Tailwind's theme.
 */
function ${fn}_tailwind_config() {
	return "tailwind.config = {
		theme: {
			extend: {
				colors: {
					primary: 'var(--color-primary)',
					'primary-contrast': 'var(--color-primary-contrast)',
					accent: 'var(--color-accent)',
					ink: 'var(--color-ink)',
					'ink-muted': 'var(--color-ink-muted)',
					surface: 'var(--color-surface)',
					'surface-alt': 'var(--color-surface-alt)',
					'border-token': 'var(--color-border)',
				},
				fontFamily: {
					sans: ['var(--font-sans)'],
					serif: ['var(--font-serif)'],
				},
				borderRadius: {
					theme: 'var(--radius)',
					'theme-sm': 'var(--radius-sm)',
					'theme-lg': 'var(--radius-lg)',
				},
				boxShadow: { card: 'var(--shadow-card)' },
				maxWidth: { container: 'var(--container)', measure: 'var(--text-measure)' },
			},
		},
	};";
}

/**
 * Widget areas.
 */
function ${fn}_widgets_init() {
	register_sidebar( array(
		'name'          => __( 'Sidebar', '${opts.slug}' ),
		'id'            => 'sidebar-1',
		'description'   => __( 'Shown alongside posts and pages that use the sidebar template.', '${opts.slug}' ),
		'before_widget' => '<section id="%1\$s" class="widget %2\$s mb-8 rounded-theme border border-border-token bg-surface-alt p-5">',
		'after_widget'  => '</section>',
		'before_title'  => '<h2 class="widget-title mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">',
		'after_title'   => '</h2>',
	) );
	register_sidebar( array(
		'name'          => __( 'Footer', '${opts.slug}' ),
		'id'            => 'footer-1',
		'description'   => __( 'Shown in the site footer.', '${opts.slug}' ),
		'before_widget' => '<section id="%1\$s" class="widget %2\$s">',
		'after_widget'  => '</section>',
		'before_title'  => '<h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">',
		'after_title'   => '</h2>',
	) );
}
add_action( 'widgets_init', '${fn}_widgets_init' );

/**
 * Menu fallback so the header is never empty on a fresh install.
 */
function ${fn}_menu_fallback() {
	echo '<a class="text-sm font-medium text-ink-muted hover:text-primary" href="' . esc_url( admin_url( 'nav-menus.php' ) ) . '">' . esc_html__( 'Set up a menu', '${opts.slug}' ) . '</a>';
}

/**
 * Excerpt tuning.
 */
add_filter( 'excerpt_length', function () { return 28; }, 20 );
add_filter( 'excerpt_more', function () { return '&hellip;'; } );

/**
 * Body classes used by the templates.
 */
add_filter( 'body_class', function ( $classes ) {
	$classes[] = 'font-sans';
	$classes[] = 'bg-surface';
	$classes[] = 'text-ink';
	$classes[] = 'antialiased';
	return $classes;
} );

// Editable fields registered by the agent are loaded from here when present.
if ( file_exists( get_theme_file_path( 'inc/fields.php' ) ) ) {
	require_once get_theme_file_path( 'inc/fields.php' );
}
`;

  files["header.php"] = `<?php
/**
 * Site header.
 *
 * @package ${opts.name}
 */
?>
<!doctype html>
<html <?php language_attributes(); ?>>
<head>
	<meta charset="<?php bloginfo( 'charset' ); ?>">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<link rel="profile" href="https://gmpg.org/xfn/11">
	<?php wp_head(); ?>
</head>

<body <?php body_class(); ?>>
<?php wp_body_open(); ?>

<a class="screen-reader-text" href="#main"><?php esc_html_e( 'Skip to content', '${opts.slug}' ); ?></a>

<header class="sticky top-0 z-40 border-b border-border-token bg-surface/85 backdrop-blur">
	<div class="mx-auto flex max-w-container items-center justify-between gap-6 px-5 py-4">

		<div class="flex items-center gap-3">
			<?php if ( has_custom_logo() ) : ?>
				<?php the_custom_logo(); ?>
			<?php else : ?>
				<a href="<?php echo esc_url( home_url( '/' ) ); ?>" class="text-lg font-bold tracking-tight text-ink hover:text-primary">
					<?php bloginfo( 'name' ); ?>
				</a>
			<?php endif; ?>
		</div>

		<nav class="hidden items-center gap-6 md:flex" aria-label="<?php esc_attr_e( 'Primary', '${opts.slug}' ); ?>">
			<?php
			wp_nav_menu( array(
				'theme_location' => 'primary',
				'container'      => false,
				'menu_class'     => 'flex items-center gap-6 list-none m-0 p-0',
				'depth'          => 2,
				'fallback_cb'    => '${fn}_menu_fallback',
				'link_before'    => '<span class="text-sm font-medium text-ink-muted transition hover:text-primary">',
				'link_after'     => '</span>',
			) );
			?>
		</nav>

		<button
			type="button"
			class="inline-flex items-center justify-center rounded-theme-sm border border-border-token p-2 md:hidden"
			aria-controls="mobile-menu"
			aria-expanded="false"
			onclick="var m=document.getElementById('mobile-menu');var e=this.getAttribute('aria-expanded')==='true';this.setAttribute('aria-expanded',String(!e));m.classList.toggle('hidden');"
		>
			<span class="screen-reader-text"><?php esc_html_e( 'Toggle menu', '${opts.slug}' ); ?></span>
			<svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
				<path fill-rule="evenodd" d="M3 5.75A.75.75 0 013.75 5h12.5a.75.75 0 010 1.5H3.75A.75.75 0 013 5.75zm0 4.5A.75.75 0 013.75 9.5h12.5a.75.75 0 010 1.5H3.75a.75.75 0 01-.75-.75zm0 4.5a.75.75 0 01.75-.75h12.5a.75.75 0 010 1.5H3.75a.75.75 0 01-.75-.75z" clip-rule="evenodd" />
			</svg>
		</button>
	</div>

	<div id="mobile-menu" class="hidden border-t border-border-token md:hidden">
		<?php
		wp_nav_menu( array(
			'theme_location' => 'primary',
			'container'      => false,
			'menu_class'     => 'flex flex-col gap-1 list-none m-0 px-5 py-4',
			'depth'          => 2,
			'fallback_cb'    => '${fn}_menu_fallback',
			'link_before'    => '<span class="block py-2 text-base font-medium text-ink hover:text-primary">',
			'link_after'     => '</span>',
		) );
		?>
	</div>
</header>

<main id="main" class="min-h-[60vh]">
`;

  files["footer.php"] = `<?php
/**
 * Site footer.
 *
 * @package ${opts.name}
 */
?>
</main>

<footer class="mt-[var(--space-section)] border-t border-border-token bg-surface-alt">
	<div class="mx-auto max-w-container px-5 py-12">

		<?php if ( is_active_sidebar( 'footer-1' ) ) : ?>
			<div class="mb-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
				<?php dynamic_sidebar( 'footer-1' ); ?>
			</div>
		<?php endif; ?>

		<div class="flex flex-col items-center justify-between gap-4 border-t border-border-token pt-8 sm:flex-row">
			<p class="text-sm text-ink-muted">
				&copy; <?php echo esc_html( gmdate( 'Y' ) ); ?> <?php bloginfo( 'name' ); ?>
			</p>
			<nav aria-label="<?php esc_attr_e( 'Footer', '${opts.slug}' ); ?>">
				<?php
				wp_nav_menu( array(
					'theme_location' => 'footer',
					'container'      => false,
					'menu_class'     => 'flex flex-wrap items-center gap-5 list-none m-0 p-0',
					'depth'          => 1,
					'fallback_cb'    => false,
					'link_before'    => '<span class="text-sm text-ink-muted hover:text-primary">',
					'link_after'     => '</span>',
				) );
				?>
			</nav>
		</div>
	</div>
</footer>

<?php wp_footer(); ?>
</body>
</html>
`;

  files["index.php"] = `<?php
/**
 * Main template — the fallback for any query without a more specific template.
 *
 * @package ${opts.name}
 */

get_header();
?>

<div class="mx-auto max-w-container px-5 py-[var(--space-section)]">

	<?php if ( is_home() && ! is_front_page() ) : ?>
		<header class="mb-12">
			<h1 class="text-4xl font-bold tracking-tight sm:text-5xl"><?php single_post_title(); ?></h1>
		</header>
	<?php endif; ?>

	<?php if ( have_posts() ) : ?>
		<div class="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
			<?php
			while ( have_posts() ) :
				the_post();
				get_template_part( 'template-parts/card' );
			endwhile;
			?>
		</div>

		<?php
		the_posts_pagination( array(
			'mid_size'           => 2,
			'class'              => 'mt-14 flex justify-center gap-2',
			'prev_text'          => __( '&larr; Newer', '${opts.slug}' ),
			'next_text'          => __( 'Older &rarr;', '${opts.slug}' ),
			'screen_reader_text' => __( 'Posts navigation', '${opts.slug}' ),
		) );
		?>
	<?php else : ?>
		<?php get_template_part( 'template-parts/none' ); ?>
	<?php endif; ?>
</div>

<?php
get_footer();
`;

  files["template-parts/card.php"] = `<?php
/**
 * Post card used in listings.
 *
 * @package ${opts.name}
 */
?>
<article id="post-<?php the_ID(); ?>" <?php post_class( 'group flex flex-col overflow-hidden rounded-theme border border-border-token bg-surface shadow-card transition hover:-translate-y-0.5 hover:shadow-lg' ); ?>>

	<?php if ( has_post_thumbnail() ) : ?>
		<a href="<?php the_permalink(); ?>" class="block overflow-hidden" aria-hidden="true" tabindex="-1">
			<?php
			the_post_thumbnail( '${opts.slug}-card', array(
				'class'   => 'h-52 w-full object-cover transition duration-300 group-hover:scale-[1.03]',
				'loading' => 'lazy',
				'alt'     => '',
			) );
			?>
		</a>
	<?php endif; ?>

	<div class="flex flex-1 flex-col p-6">
		<?php
		$categories = get_the_category();
		if ( ! empty( $categories ) ) :
			?>
			<a class="mb-3 self-start rounded-theme-sm bg-primary/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-primary"
			   href="<?php echo esc_url( get_category_link( $categories[0]->term_id ) ); ?>">
				<?php echo esc_html( $categories[0]->name ); ?>
			</a>
		<?php endif; ?>

		<h2 class="text-xl font-semibold leading-snug tracking-tight">
			<a class="text-ink transition hover:text-primary" href="<?php the_permalink(); ?>"><?php the_title(); ?></a>
		</h2>

		<p class="mt-3 flex-1 text-sm leading-relaxed text-ink-muted"><?php echo esc_html( get_the_excerpt() ); ?></p>

		<div class="mt-5 flex items-center gap-3 text-xs text-ink-muted">
			<?php echo get_avatar( get_the_author_meta( 'ID' ), 28, '', '', array( 'class' => 'rounded-full' ) ); ?>
			<span><?php the_author(); ?></span>
			<span aria-hidden="true">&middot;</span>
			<time datetime="<?php echo esc_attr( get_the_date( 'c' ) ); ?>"><?php echo esc_html( get_the_date() ); ?></time>
		</div>
	</div>
</article>
`;

  files["template-parts/none.php"] = `<?php
/**
 * Shown when a query returns nothing.
 *
 * @package ${opts.name}
 */
?>
<div class="mx-auto max-w-measure rounded-theme border border-border-token bg-surface-alt p-10 text-center">
	<h2 class="text-2xl font-semibold"><?php esc_html_e( 'Nothing found', '${opts.slug}' ); ?></h2>
	<p class="mt-3 text-ink-muted">
		<?php esc_html_e( 'We could not find anything matching that. Try a different search.', '${opts.slug}' ); ?>
	</p>
	<div class="mt-6 flex justify-center"><?php get_search_form(); ?></div>
</div>
`;

  files["single.php"] = `<?php
/**
 * Single post.
 *
 * @package ${opts.name}
 */

get_header();

while ( have_posts() ) :
	the_post();
	?>

	<article id="post-<?php the_ID(); ?>" <?php post_class(); ?>>

		<header class="border-b border-border-token bg-surface-alt">
			<div class="mx-auto max-w-measure px-5 py-[var(--space-section)]">
				<?php
				$categories = get_the_category();
				if ( ! empty( $categories ) ) :
					?>
					<a class="mb-4 inline-block rounded-theme-sm bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-primary"
					   href="<?php echo esc_url( get_category_link( $categories[0]->term_id ) ); ?>">
						<?php echo esc_html( $categories[0]->name ); ?>
					</a>
				<?php endif; ?>

				<h1 class="text-4xl font-bold leading-tight tracking-tight sm:text-5xl"><?php the_title(); ?></h1>

				<div class="mt-6 flex flex-wrap items-center gap-3 text-sm text-ink-muted">
					<?php echo get_avatar( get_the_author_meta( 'ID' ), 36, '', '', array( 'class' => 'rounded-full' ) ); ?>
					<span class="font-medium text-ink"><?php the_author(); ?></span>
					<span aria-hidden="true">&middot;</span>
					<time datetime="<?php echo esc_attr( get_the_date( 'c' ) ); ?>"><?php echo esc_html( get_the_date() ); ?></time>
					<span aria-hidden="true">&middot;</span>
					<span><?php echo esc_html( ${fn}_reading_time() ); ?></span>
				</div>
			</div>
		</header>

		<?php if ( has_post_thumbnail() ) : ?>
			<div class="mx-auto max-w-container px-5">
				<?php the_post_thumbnail( 'large', array( 'class' => '-mt-10 w-full rounded-theme object-cover shadow-card' ) ); ?>
			</div>
		<?php endif; ?>

		<div class="mx-auto max-w-measure px-5 py-14">
			<div class="entry-content text-lg">
				<?php
				the_content();
				wp_link_pages( array(
					'before' => '<nav class="mt-8 flex gap-2 text-sm">',
					'after'  => '</nav>',
				) );
				?>
			</div>

			<?php if ( has_tag() ) : ?>
				<div class="mt-10 flex flex-wrap gap-2 border-t border-border-token pt-8">
					<?php
					foreach ( get_the_tags() as $tag ) :
						?>
						<a class="rounded-theme-sm border border-border-token px-3 py-1 text-sm text-ink-muted transition hover:border-primary hover:text-primary"
						   href="<?php echo esc_url( get_tag_link( $tag->term_id ) ); ?>">#<?php echo esc_html( $tag->name ); ?></a>
					<?php endforeach; ?>
				</div>
			<?php endif; ?>

			<nav class="mt-12 grid gap-4 border-t border-border-token pt-8 sm:grid-cols-2">
				<?php
				$prev = get_previous_post();
				$next = get_next_post();
				if ( $prev ) :
					?>
					<a class="rounded-theme border border-border-token p-5 transition hover:border-primary" href="<?php echo esc_url( get_permalink( $prev ) ); ?>">
						<span class="text-xs uppercase tracking-wide text-ink-muted"><?php esc_html_e( 'Previous', '${opts.slug}' ); ?></span>
						<span class="mt-1 block font-semibold"><?php echo esc_html( get_the_title( $prev ) ); ?></span>
					</a>
				<?php endif; ?>
				<?php if ( $next ) : ?>
					<a class="rounded-theme border border-border-token p-5 text-right transition hover:border-primary sm:col-start-2" href="<?php echo esc_url( get_permalink( $next ) ); ?>">
						<span class="text-xs uppercase tracking-wide text-ink-muted"><?php esc_html_e( 'Next', '${opts.slug}' ); ?></span>
						<span class="mt-1 block font-semibold"><?php echo esc_html( get_the_title( $next ) ); ?></span>
					</a>
				<?php endif; ?>
			</nav>

			<?php
			if ( comments_open() || get_comments_number() ) {
				comments_template();
			}
			?>
		</div>
	</article>

	<?php
endwhile;

get_footer();
`;

  files["page.php"] = `<?php
/**
 * Single page.
 *
 * @package ${opts.name}
 */

get_header();

while ( have_posts() ) :
	the_post();
	?>

	<article id="post-<?php the_ID(); ?>" <?php post_class(); ?>>
		<header class="mx-auto max-w-measure px-5 pt-[var(--space-section)]">
			<h1 class="text-4xl font-bold tracking-tight sm:text-5xl"><?php the_title(); ?></h1>
		</header>

		<?php if ( has_post_thumbnail() ) : ?>
			<div class="mx-auto mt-10 max-w-container px-5">
				<?php the_post_thumbnail( 'large', array( 'class' => 'w-full rounded-theme object-cover shadow-card' ) ); ?>
			</div>
		<?php endif; ?>

		<div class="mx-auto max-w-measure px-5 py-12">
			<div class="entry-content text-lg"><?php the_content(); ?></div>
			<?php
			if ( comments_open() || get_comments_number() ) {
				comments_template();
			}
			?>
		</div>
	</article>

	<?php
endwhile;

get_footer();
`;

  files["archive.php"] = `<?php
/**
 * Archives — category, tag, author, date and custom post type.
 *
 * @package ${opts.name}
 */

get_header();
?>

<div class="mx-auto max-w-container px-5 py-[var(--space-section)]">

	<header class="mb-12 max-w-measure">
		<h1 class="text-4xl font-bold tracking-tight sm:text-5xl"><?php the_archive_title(); ?></h1>
		<?php
		$description = get_the_archive_description();
		if ( $description ) :
			?>
			<div class="mt-4 text-lg text-ink-muted"><?php echo wp_kses_post( $description ); ?></div>
		<?php endif; ?>
	</header>

	<?php if ( have_posts() ) : ?>
		<div class="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
			<?php
			while ( have_posts() ) :
				the_post();
				get_template_part( 'template-parts/card' );
			endwhile;
			?>
		</div>

		<?php
		the_posts_pagination( array(
			'mid_size' => 2,
			'class'    => 'mt-14 flex justify-center gap-2',
		) );
		?>
	<?php else : ?>
		<?php get_template_part( 'template-parts/none' ); ?>
	<?php endif; ?>
</div>

<?php
get_footer();
`;

  files["search.php"] = `<?php
/**
 * Search results.
 *
 * @package ${opts.name}
 */

get_header();
?>

<div class="mx-auto max-w-container px-5 py-[var(--space-section)]">
	<header class="mb-10 max-w-measure">
		<h1 class="text-3xl font-bold tracking-tight sm:text-4xl">
			<?php
			printf(
				/* translators: %s: search query. */
				esc_html__( 'Results for %s', '${opts.slug}' ),
				'<span class="text-primary">' . esc_html( get_search_query() ) . '</span>'
			);
			?>
		</h1>
		<div class="mt-6 max-w-md"><?php get_search_form(); ?></div>
	</header>

	<?php if ( have_posts() ) : ?>
		<div class="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
			<?php
			while ( have_posts() ) :
				the_post();
				get_template_part( 'template-parts/card' );
			endwhile;
			?>
		</div>
		<?php the_posts_pagination( array( 'mid_size' => 2, 'class' => 'mt-14 flex justify-center gap-2' ) ); ?>
	<?php else : ?>
		<?php get_template_part( 'template-parts/none' ); ?>
	<?php endif; ?>
</div>

<?php
get_footer();
`;

  files["404.php"] = `<?php
/**
 * 404.
 *
 * @package ${opts.name}
 */

get_header();
?>

<div class="mx-auto flex max-w-measure flex-col items-center px-5 py-[var(--space-section)] text-center">
	<p class="text-7xl font-bold text-primary">404</p>
	<h1 class="mt-4 text-3xl font-bold tracking-tight sm:text-4xl"><?php esc_html_e( 'Page not found', '${opts.slug}' ); ?></h1>
	<p class="mt-4 text-lg text-ink-muted">
		<?php esc_html_e( 'That page has moved or never existed. Try a search, or head back to the homepage.', '${opts.slug}' ); ?>
	</p>
	<div class="mt-8 w-full max-w-md"><?php get_search_form(); ?></div>
	<a class="mt-6 inline-flex items-center rounded-theme bg-primary px-5 py-2.5 font-semibold text-primary-contrast transition hover:opacity-90"
	   href="<?php echo esc_url( home_url( '/' ) ); ?>">
		<?php esc_html_e( 'Back to home', '${opts.slug}' ); ?>
	</a>
</div>

<?php
get_footer();
`;

  files["searchform.php"] = `<?php
/**
 * Search form.
 *
 * @package ${opts.name}
 */
?>
<form role="search" method="get" class="flex gap-2" action="<?php echo esc_url( home_url( '/' ) ); ?>">
	<label class="flex-1">
		<span class="screen-reader-text"><?php esc_html_e( 'Search for:', '${opts.slug}' ); ?></span>
		<input
			type="search"
			class="w-full rounded-theme border border-border-token bg-surface px-4 py-2.5 text-ink outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
			placeholder="<?php esc_attr_e( 'Search&hellip;', '${opts.slug}' ); ?>"
			value="<?php echo esc_attr( get_search_query() ); ?>"
			name="s"
		/>
	</label>
	<button type="submit" class="rounded-theme bg-primary px-5 py-2.5 font-semibold text-primary-contrast transition hover:opacity-90">
		<?php esc_html_e( 'Search', '${opts.slug}' ); ?>
	</button>
</form>
`;

  files["sidebar.php"] = `<?php
/**
 * Sidebar.
 *
 * @package ${opts.name}
 */

if ( ! is_active_sidebar( 'sidebar-1' ) ) {
	return;
}
?>
<aside class="w-full lg:w-80" aria-label="<?php esc_attr_e( 'Sidebar', '${opts.slug}' ); ?>">
	<?php dynamic_sidebar( 'sidebar-1' ); ?>
</aside>
`;

  files["comments.php"] = `<?php
/**
 * Comments.
 *
 * @package ${opts.name}
 */

if ( post_password_required() ) {
	return;
}
?>

<section id="comments" class="mt-14 border-t border-border-token pt-10">

	<?php if ( have_comments() ) : ?>
		<h2 class="text-2xl font-semibold">
			<?php
			printf(
				/* translators: %d: comment count. */
				esc_html( _n( '%d comment', '%d comments', get_comments_number(), '${opts.slug}' ) ),
				(int) get_comments_number()
			);
			?>
		</h2>

		<ol class="mt-8 space-y-6 list-none p-0">
			<?php
			wp_list_comments( array(
				'style'       => 'ol',
				'short_ping'  => true,
				'avatar_size' => 44,
			) );
			?>
		</ol>

		<?php
		the_comments_pagination( array(
			'class' => 'mt-8 flex justify-center gap-2',
		) );
		?>
	<?php endif; ?>

	<?php
	comment_form( array(
		'class_form'         => 'mt-10 space-y-4',
		'title_reply_before' => '<h3 class="text-xl font-semibold">',
		'title_reply_after'  => '</h3>',
		'class_submit'       => 'rounded-theme bg-primary px-5 py-2.5 font-semibold text-primary-contrast transition hover:opacity-90',
		'comment_field'      => '<p class="comment-form-comment"><label class="mb-1 block text-sm font-medium" for="comment">' . esc_html__( 'Comment', '${opts.slug}' ) . '</label><textarea id="comment" name="comment" rows="5" required class="w-full rounded-theme border border-border-token bg-surface px-4 py-3 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"></textarea></p>',
	) );
	?>
</section>
`;

  files["inc/template-functions.php"] = `<?php
/**
 * Template helpers.
 *
 * @package ${opts.name}
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Estimated reading time for the current post.
 *
 * @param int|null $post_id Post ID, or null for the current post.
 * @return string
 */
function ${fn}_reading_time( $post_id = null ) {
	$content = get_post_field( 'post_content', $post_id ?: get_the_ID() );
	$words   = str_word_count( wp_strip_all_tags( $content ) );
	$minutes = max( 1, (int) ceil( $words / 200 ) );

	return sprintf(
		/* translators: %d: minutes. */
		_n( '%d min read', '%d min read', $minutes, '${opts.slug}' ),
		$minutes
	);
}
`;

  files["README.md"] = `# ${opts.name}

A classic WordPress theme generated by wpxmcp, styled with Tailwind utilities.

## Where things live

| File | Purpose |
| --- | --- |
| \`theme.css\` | **Design tokens.** Colors, fonts, radii, spacing. Change the look here. |
| \`functions.php\` | Theme setup, asset loading, Tailwind→token mapping, widget areas. |
| \`header.php\` / \`footer.php\` | Site chrome and navigation. |
| \`index.php\` | Blog listing and universal fallback. |
| \`single.php\` / \`page.php\` | Single post and single page. |
| \`archive.php\` / \`search.php\` / \`404.php\` | Listing and utility templates. |
| \`template-parts/\` | Reusable fragments (\`card.php\`, \`none.php\`). |
| \`inc/\` | PHP helpers, and \`fields.php\` when editable fields are registered. |

## Rules that keep it maintainable

1. **Never hardcode a color, font or radius in a template.** Use the Tailwind
   aliases (\`bg-primary\`, \`text-ink-muted\`, \`rounded-theme\`) which resolve to the
   custom properties in \`theme.css\`.
2. **Escape all output** — \`esc_html()\`, \`esc_url()\`, \`esc_attr()\`, \`wp_kses_post()\`.
3. **Editorial content stays editable.** Anything a human should change belongs in a
   post, a menu, a widget or a registered field — not in a template.

## Production Tailwind

The scaffold loads Tailwind from the Play CDN so it works immediately. Before a
real launch, compile it and swap the CDN script in \`functions.php\` for the built
stylesheet:

\`\`\`bash
npx tailwindcss -i ./src/input.css -o ./assets/app.css --minify
\`\`\`
`;

  // Append the reading-time include to functions.php.
  files["functions.php"] += `
require_once get_theme_file_path( 'inc/template-functions.php' );
`;

  return files;
}
